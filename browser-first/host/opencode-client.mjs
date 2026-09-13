// Thin host-side client for a running `opencode serve` (its plain HTTP + SSE API),
// plus a lifecycle helper that ensures the server is up. Kept dependency-free
// (no @opencode-ai/sdk) — the server is a plain HTTP server — and fully
// dependency-injected so the lifecycle/state machine is unit-testable without
// spawning a real process.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const RESERVED_PORTS = [4096, 4231]; // port-literal-allowlist: rejected ports
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const PROMPT_FALLBACK_TIMEOUT_MS = 600_000;
const BRIDGE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inflight = new Map();
const children = new Set();
const writtenPidRecordDirectories = new Map();
let hooksInstalled = false;
let stalePidCleanupDone = false;
let stalePidSkipWrite = false;

export function basicAuthHeader(username, password) {
  return "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

export function opencodeBaseUrl({ hostname = DEFAULT_HOST, port } = {}) {
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("OpenCode base URL requires a positive integer port.");
  }
  return `http://${hostname}:${port}`;
}

export function opencodeServeBaseUrl(serverInfo = {}) {
  const raw = typeof serverInfo === "string" ? serverInfo : serverInfo?.baseUrl;
  const url = new URL(String(raw ?? ""));
  if (url.protocol !== "http:") {
    throw new Error("OpenCode serve URL must use http on a loopback literal.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("OpenCode serve URL must use the 127.0.0.1 loopback literal.");
  }
  url.username = "";
  url.password = "";
  url.hostname = "127.0.0.1";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function pickFreeLoopbackPort({
  netImpl = net,
  hostname = DEFAULT_HOST,
  avoid = RESERVED_PORTS,
  attempts = 8
} = {}) {
  const avoided = new Set(avoid);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const srv = netImpl.createServer();
    try {
      await new Promise((res, rej) => {
        srv.once("error", rej);
        srv.listen(0, hostname, res);
      });
      const address = srv.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      await new Promise((r) => srv.close(r));
      if (!avoided.has(port) && port >= 1024) return port;
    } catch {
      try { srv.close(() => {}); } catch { /* noop */ }
    }
  }
  throw new Error("Could not pick a free loopback port for OpenCode.");
}

// Is a server already answering at baseUrl? Probes the OpenAPI doc (always
// present, needs no provider) with a short timeout.
export async function opencodeServerHealthy({ fetchImpl, baseUrl, headers = {}, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${baseUrl}/doc`, { method: "GET", headers: { ...headers }, signal: controller?.signal, redirect: "error" });
    return Boolean(res && res.status === 200);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Deliberate enforcement check: a request WITHOUT the credential must be rejected.
// A 2xx here means the listener does not require the bridge credential (a foreign
// or misconfigured server) and must never be adopted, whatever the authed probe said.
export async function opencodeServerEnforcesAuth({ fetchImpl, baseUrl, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${baseUrl}/doc`, { method: "GET", signal: controller?.signal, redirect: "error" });
    return Boolean(res) && res.status === 401;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resetOpencodeServerSingletonForTests() {
  inflight.clear();
  children.clear();
  writtenPidRecordDirectories.clear();
  hooksInstalled = false;
  stalePidCleanupDone = false;
  stalePidSkipWrite = false;
}

export function forgetOpencodeServer(serverInfo) {
  if (serverInfo?.key) {
    const owned = inflight.get(serverInfo.key)?.serverInfo;
    if (owned === serverInfo || (owned?.process && owned.process === serverInfo.process)) inflight.delete(serverInfo.key);
    return;
  }
  for (const [key, value] of inflight.entries()) {
    if (value === serverInfo || value?.serverInfo === serverInfo) inflight.delete(key);
  }
}

// Look up the registered singleton (if any) WITHOUT spawning. Returns the stored
// server info, or null when nothing is registered (or a spawn is still in flight).
export function peekOpencodeServer({ command, hostname = DEFAULT_HOST, cwd, env = process.env } = {}) {
  const directory = resolveOpencodeCwd({ cwd, env });
  const envPort = Number(env.RESONANTOS_OPENCODE_PORT);
  const explicitPort = Number.isInteger(envPort) && envPort > 0 ? envPort : 0;
  const key = `${command}|${hostname}|${directory}|${explicitPort}`;
  return inflight.get(key)?.serverInfo ?? null;
}

export function createDefaultPidRecord(env = process.env) {
  const root = env.RESONANTOS_BROWSER_FIRST_USER_ROOT ?? join(homedir(), "ResonantOS_User");
  const path = join(root, "BrowserFirst", "opencode-server.json");
  return {
    path,
    read: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return null;
      }
    },
    write: async (_directory, rec) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(rec, null, 2), { mode: 0o600 });
    },
    clear: () => {
      try { rmSync(path, { force: true }); } catch { /* noop */ }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    commandOf: (pid) => {
      try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    },
    kill: (pid) => {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  };
}

// Ensure `opencode serve` is running at the resolved base URL. Reuses an already
// healthy server; otherwise spawns one and waits for it to answer. Returns
// { baseUrl, spawned, process|null }. Never throws for a benign "already up".
export async function ensureOpencodeServer({
  fetchImpl,
  spawnImpl,
  command,
  hostname = DEFAULT_HOST,
  port,
  cwd,
  env = process.env,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxWaitMs = 12000,
  pollMs = 300,
  processImpl = process,
  pidRecord = createDefaultPidRecord(env),
  pickEphemeralPort = pickFreeLoopbackPort
} = {}) {
  const directory = resolveOpencodeCwd({ cwd, env });
  const envPort = Number(env.RESONANTOS_OPENCODE_PORT);
  const explicitPort = Number.isInteger(port) && port > 0 ? port : (envPort > 0 ? envPort : 0);
  if ((explicitPort && (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65535 || isReservedPort(explicitPort)))
      || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) throw clientError("OPENCODE_INVALID_REQUEST", 400);
  // Per-process runtime config is immutable for the bridge lifetime.
  const key = `${command}|${hostname}|${directory}|${explicitPort}`;
  if (inflight.has(key)) {
    const info = await inflight.get(key);
    if (info?.auth?.header
      && await opencodeServerHealthy({ fetchImpl, baseUrl: info.baseUrl, headers: { Authorization: info.auth.header } })
      && await opencodeServerEnforcesAuth({ fetchImpl, baseUrl: info.baseUrl })) {
      return { ...info, spawned: false };
    }
    inflight.delete(key);
  }

  const p = startOpencodeServer({
    fetchImpl,
    spawnImpl,
    command,
    hostname,
    explicitPort,
    directory,
    env,
    sleep,
    maxWaitMs,
    pollMs,
    processImpl,
    pidRecord,
    pickEphemeralPort,
    key
  });
  inflight.set(key, p);
  p.then((info) => {
    p.serverInfo = info;
    return info;
  }, () => {});
  p.catch(() => inflight.delete(key));
  return await p;
}

async function startOpencodeServer({
  fetchImpl,
  spawnImpl,
  command,
  hostname,
  explicitPort,
  directory,
  env,
  sleep,
  maxWaitMs,
  pollMs,
  processImpl,
  pidRecord,
  pickEphemeralPort,
  key
}) {
  if (!command || typeof spawnImpl !== "function") {
    throw new Error("OpenCode runtime is not available to start (no command resolved).");
  }

  const username = "opencode";
  const password = typeof env.OPENCODE_SERVER_PASSWORD === "string" && env.OPENCODE_SERVER_PASSWORD
    ? env.OPENCODE_SERVER_PASSWORD
    : randomBytes(32).toString("base64url");
  const header = basicAuthHeader(username, password);

  const skipWrite = await cleanupStalePidOnce(pidRecord, directory, processImpl);
  const spawnPort = explicitPort > 0 ? explicitPort : await pickEphemeralPort({ hostname });

  if (!Number.isInteger(spawnPort) || spawnPort < 1024 || spawnPort > 65535 || isReservedPort(spawnPort)) throw clientError("OPENCODE_INVALID_REQUEST", 400);
  const startedAt = Date.now();
  const child = spawnImpl(command, ["serve", "--hostname", hostname, "--port", String(spawnPort)], {
    cwd: directory,
    env: { ...env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "ignore"]
  });
  children.add(child);
  let exited = false;
  child.once?.("exit", () => {
    exited = true;
    children.delete(child);
    // Only drop the singleton entry this child owns: a stale child's late exit must not
    // clobber a newer server registered under the same key (stop->start, stale-health respawn).
    const registered = inflight.get(key)?.serverInfo?.process;
    if (registered === child) inflight.delete(key);
    // Likewise only clear the pid record when no newer server is registered under this key,
    // and only when THIS process owns the recorded server (a foreign bridge's record is left).
    if (registered === undefined || registered === child) {
      (async () => {
        try {
          const record = await pidRecord.read(directory);
          if (record?.owner === processImpl.pid) {
            try {
              await pidRecord.clear(directory);
            } catch { /* noop */ }
          }
        } catch { /* noop */ }
      })();
    }
  });

  const announcedPortPromise = waitForAnnouncedPort(child, spawnPort, maxWaitMs);
  let announcedPort;
  try { announcedPort = await announcedPortPromise; }
  catch { try { child.kill(); } catch {} throw clientError("OPENCODE_PROTOCOL_ERROR", 502); }
  const baseUrl = opencodeBaseUrl({ hostname, port: announcedPort });
  const deadline = startedAt + maxWaitMs;
  while (true) {
    if (exited) {
      throw new Error("OpenCode server exited before becoming ready.");
    }
    if (await opencodeServerHealthy({ fetchImpl, baseUrl, headers: { Authorization: header } })) {
      if (!(await opencodeServerEnforcesAuth({ fetchImpl, baseUrl }))) {
        try { child?.kill?.(); } catch { /* noop */ }
        throw new Error("OpenCode server does not enforce the bridge credential; refusing to adopt it.");
      }
      installShutdownHooks(processImpl);
      if (!skipWrite) {
        await pidRecord.write(directory, { owner: processImpl.pid, pid: child.pid, port: announcedPort, startedAt: Date.now() });
        trackWrittenPidRecord(pidRecord, directory);
      }
      return { key, baseUrl, spawned: true, process: child, directory, auth: { username, password, header } };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  try { child?.kill?.(); } catch { /* noop */ }
  throw new Error("OpenCode server did not become ready in time.");
}

function waitForAnnouncedPort(child, spawnPort, maxWaitMs) {
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    let settled = false;
    let timer = null;
    const finish = (port) => {
      if (settled) return;
      settled = true;
      child.stdout?.on?.("data", () => {});
      child.stdout?.resume?.();
      if (timer) clearTimeout(timer);
      resolvePort(port);
    };
    timer = setTimeout(() => {
      finish(spawnPort);
    }, maxWaitMs);
    child.stdout?.on?.("data", (chunk) => {
      if (settled) return;
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (buffer.length > 16384) { buffer = buffer.slice(-16384); }
      const match = buffer.match(/listening on (https?:\/\/[^\s]+)/i);
      if (match) {
        let url;
        try { url = new URL(match[1]); } catch {}
        if (!url || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || Number(url.port) !== spawnPort || isReservedPort(Number(url.port))) {
          settled = true; clearTimeout(timer); reject(clientError("OPENCODE_PROTOCOL_ERROR", 502));
        } else finish(Number(url.port));
      }
    });
  });
}

async function cleanupStalePidOnce(pidRecord, directory, processImpl) {
  if (stalePidCleanupDone) return stalePidSkipWrite;
  stalePidCleanupDone = true;
  const stale = await pidRecord.read(directory);
  if (stale?.pid) {
    const ownerAlive = stale.owner != null && pidRecord.isAlive(stale.owner);
    if (ownerAlive && stale.owner !== processImpl.pid) {
      // A LIVE other bridge/process owns this server: never kill it, never overwrite its record.
      stalePidSkipWrite = true;
    } else if (pidRecord.isAlive(stale.pid) && /\bopencode(?:\.exe|\.cmd)?\s+serve\b/i.test(pidRecord.commandOf(stale.pid))) {
      pidRecord.kill(stale.pid);
    } else if (!pidRecord.isAlive(stale.pid)) {
      try { pidRecord.clear(directory); } catch { /* noop */ }
    }
  }
  return stalePidSkipWrite;
}

function trackWrittenPidRecord(pidRecord, directory) {
  const directories = writtenPidRecordDirectories.get(pidRecord) ?? new Set();
  directories.add(directory);
  writtenPidRecordDirectories.set(pidRecord, directories);
}

function clearWrittenPidRecords() {
  for (const [pidRecord, directories] of writtenPidRecordDirectories.entries()) {
    for (const directory of directories) {
      try { pidRecord.clear(directory); } catch { /* noop */ }
    }
  }
  writtenPidRecordDirectories.clear();
}

function installShutdownHooks(processImpl) {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => {
    for (const child of children) {
      try { child?.kill?.(); } catch { /* noop */ }
    }
    clearWrittenPidRecords();
  };
  processImpl.once?.("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    processImpl.on?.(sig, () => {
      killAll();
      processImpl.exit?.(sig === "SIGINT" ? 130 : 143);
    });
  }
}

function resolveOpencodeCwd({ cwd, env = process.env } = {}) {
  const explicit = typeof cwd === "string" && cwd.trim() ? cwd.trim() : "";
  const configured = typeof env?.RESONANTOS_OPENCODE_CWD === "string" && env.RESONANTOS_OPENCODE_CWD.trim()
    ? env.RESONANTOS_OPENCODE_CWD.trim()
    : "";
  return explicit || configured || BRIDGE_REPO_ROOT;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function textParts(parts) {
  return Array.isArray(parts) ? parts : [{ type: "text", text: String(parts ?? "") }];
}

function modelPayload(model) {
  const raw = String(model ?? "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return {
    providerID: raw.slice(0, slash),
    modelID: raw.slice(slash + 1)
  };
}

function appendQuery(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

// Minimal typed wrapper over the server's session endpoints.
export function createOpencodeHttpClient(options = {}) {
  const {
    fetchImpl,
    baseUrl,
    headers = {},
    directory,
    workspace,
    apiDoc,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    promptFallbackTimeoutMs = PROMPT_FALLBACK_TIMEOUT_MS,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout
  } = options;
  const pinnedDirectory = Object.hasOwn(options, "directory") ? directory : resolveOpencodeCwd({ env: process.env });
  let cachedDoc = apiDoc ?? null;
  let docLoaded = Boolean(apiDoc);
  let docPromise = null;
  let cachedSupport;

  if (typeof fetchImpl !== "function" || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(headers.Authorization ?? "")) throw clientError("OPENCODE_UPSTREAM_AUTH", 502);
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw clientError("OPENCODE_INVALID_REQUEST", 400);
  const generationSignal = options.signal;
  const checkGeneration = () => { if (generationSignal?.aborted) throw clientError("OPENCODE_REVOKED", 403); };
  generationSignal?.addEventListener("abort", () => { cachedDoc = null; docLoaded = false; docPromise = null; cachedSupport = undefined; }, { once: true });

  // The timeout and generation cancellation cover fetch AND bounded body consumption.
  const fetchWithTimeout = async (_callName, url, init = {}, timeoutMs = requestTimeoutMs) => {
    checkGeneration();
    const controller = new AbortController();
    const abort = () => controller.abort();
    generationSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeoutImpl(abort, timeoutMs);
    let onAbort, bodyReader;
    const canceled = new Promise((_, reject) => {
      onAbort = () => { void bodyReader?.cancel().catch(() => {}); reject(clientError(generationSignal?.aborted ? "OPENCODE_REVOKED" : "OPENCODE_TIMEOUT", generationSignal?.aborted ? 403 : 504)); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([canceled, (async () => {
        const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: "error" });
        checkGeneration();
        if (res?.status === 401 || res?.status === 403) throw clientError("OPENCODE_UPSTREAM_AUTH", 502);
        if (!res || res.status < 200 || res.status >= 300) throw clientError("OPENCODE_UPSTREAM_FAILED", 502);
        let text = "";
        if (res.body?.getReader) {
          const reader = res.body.getReader(); bodyReader = reader; const chunks = []; let size = 0, complete = false;
          try { while (true) { const { done, value } = await reader.read(); if (done) { complete = true; break; } size += value.byteLength; if (size > 1048576) throw clientError("OPENCODE_PROTOCOL_ERROR", 502); chunks.push(Buffer.from(value)); } }
          finally { if (!complete || controller.signal.aborted) await reader.cancel().catch(() => {}); reader.releaseLock(); bodyReader = null; }
          text = Buffer.concat(chunks).toString("utf8");
        } else { text = await res.text(); if (Buffer.byteLength(text) > 1048576) throw clientError("OPENCODE_PROTOCOL_ERROR", 502); }
        checkGeneration();
        if (controller.signal.aborted) throw clientError("OPENCODE_TIMEOUT", 504);
        try { return text ? JSON.parse(text) : null; } catch { throw clientError("OPENCODE_PROTOCOL_ERROR", 502); }
      })()]);
    } catch (error) {
      if (error?.code?.startsWith("OPENCODE_")) throw error;
      throw clientError("OPENCODE_UPSTREAM_FAILED", 502);
    } finally {
      clearTimeoutImpl(timer); generationSignal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onAbort);
    }
  };
  const loadApiDoc = async () => {
    checkGeneration();
    if (docLoaded) return cachedDoc;
    if (!docPromise) docPromise = (async () => {
      const doc = await fetchWithTimeout("loadApiDoc", `${baseUrl}/doc`, { method: "GET", headers: { ...headers } });
      if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.paths || typeof doc.paths !== "object") throw clientError("OPENCODE_PROTOCOL_ERROR", 502);
      checkGeneration(); cachedDoc = doc; docLoaded = true; return doc;
    })().finally(() => { docPromise = null; });
    return docPromise;
  };
  const hasEndpoint = async (path, method) => Boolean((await loadApiDoc())?.paths?.[path]?.[method.toLowerCase()]);
  const resolveLocal = (value, doc, seen = new Set()) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (!value.$ref) return value;
    const ref = value.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/") || seen.has(ref)) throw clientError("OPENCODE_PROTOCOL_ERROR", 502);
    seen.add(ref);
    let target = doc;
    for (const key of ref.slice(2).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"))) target = Object.hasOwn(target ?? {}, key) ? target[key] : null;
    if (!target) throw clientError("OPENCODE_PROTOCOL_ERROR", 502);
    return resolveLocal(target, doc, seen);
  };
  const routeQuery = (extra = {}) => ({
    ...(pinnedDirectory ? { directory: pinnedDirectory } : {}),
    ...(workspace ? { workspace } : {}),
    ...extra
  });

  const call = async (callName, method, path, body, query, { timeoutMs = requestTimeoutMs } = {}) => {
    const fullPath = appendQuery(path, query);
    return fetchWithTimeout(callName, `${baseUrl}${fullPath}`, {
      method, headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, timeoutMs);
  };

  return {
    createSession: (title = "ResonantOS session") => call("createSession", "POST", "/session", { title }, routeQuery()),
    supportsPromptMessageId: async () => {
      checkGeneration();
      if (cachedSupport !== undefined) return cachedSupport;
      const doc = await loadApiDoc();
      const path = doc.paths?.["/session/{sessionID}/prompt_async"] ? "/session/{sessionID}/prompt_async" : "/session/{sessionID}/message";
      const body = resolveLocal(doc.paths?.[path]?.post?.requestBody, doc);
      const schema = resolveLocal(body?.content?.["application/json"]?.schema, doc);
      cachedSupport = Boolean(resolveLocal(schema?.properties?.messageID, doc));
      return cachedSupport;
    },
    prompt: async (sessionId, parts, { model, agent, messageID } = {}) => {
      const usesPromptAsync = await hasEndpoint("/session/{sessionID}/prompt_async", "POST");
      const path = usesPromptAsync
        ? `/session/${encodePathSegment(sessionId)}/prompt_async`
        : `/session/${encodePathSegment(sessionId)}/message`;
      const structuredModel = modelPayload(model);
      return call("prompt", "POST", path, {
        parts: textParts(parts),
        ...(messageID ? { messageID } : {}),
        ...(structuredModel ? { model: structuredModel } : {}),
        ...(agent ? { agent } : {})
      }, routeQuery(), { timeoutMs: usesPromptAsync ? requestTimeoutMs : promptFallbackTimeoutMs });
    },
    replyPermission: (sessionId, permissionId, decision) =>
      call("replyPermission", "POST", `/session/${encodePathSegment(sessionId)}/permissions/${encodePathSegment(permissionId)}`, {
        response: decision?.approved ? (decision?.remember ? "always" : "once") : "reject"
      }, routeQuery()),
    abort: (sessionId) => call("abort", "POST", `/session/${encodePathSegment(sessionId)}/abort`, undefined, routeQuery()),
    sessionDiff: (sessionId, { messageID } = {}) =>
      call("sessionDiff", "GET", `/session/${encodePathSegment(sessionId)}/diff`, undefined, routeQuery({ ...(messageID ? { messageID } : {}) })),
    rename: (sessionId, title) =>
      call("rename", "PATCH", `/session/${encodePathSegment(sessionId)}`, { title }, routeQuery()),
    remove: (sessionId) => call("delete", "DELETE", `/session/${encodePathSegment(sessionId)}`, undefined, routeQuery()),
    archive: (sessionId, archived = Date.now()) =>
      call("archive", "PATCH", `/session/${encodePathSegment(sessionId)}`, { time: { archived } }, routeQuery()),
    listAgents: () => call("listAgents", "GET", "/agent", undefined, routeQuery()),
    listSessions: () => call("listSessions", "GET", "/session", undefined, routeQuery()),
    messages: (sessionId) => call("messages", "GET", `/session/${encodePathSegment(sessionId)}/message`, undefined, routeQuery()),
    eventUrl: () => `${baseUrl}/event`
  };
}

function isReservedPort(port) { return RESERVED_PORTS.includes(port); }

function clientError(code, status) { const error = new Error("OpenCode boundary request failed."); error.code = code; error.status = status; return error; }
