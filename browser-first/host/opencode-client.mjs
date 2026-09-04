// Thin host-side client for a running `opencode serve` (its plain HTTP + SSE API),
// plus a lifecycle helper that ensures the server is up. Kept dependency-free
// (no @opencode-ai/sdk) — the server is a plain HTTP server — and fully
// dependency-injected so the lifecycle/state machine is unit-testable without
// spawning a real process.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const PROMPT_FALLBACK_TIMEOUT_MS = 600_000;
const BRIDGE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inflight = new Map();
const children = new Set();
let hooksInstalled = false;
let stalePidCleanupDone = false;

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

// Is a server already answering at baseUrl? Probes the OpenAPI doc (always
// present, needs no provider) with a short timeout.
export async function opencodeServerHealthy({ fetchImpl, baseUrl, headers = {}, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${baseUrl}/doc`, { method: "GET", headers: { ...headers }, signal: controller?.signal });
    return Boolean(res && res.ok);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resetOpencodeServerSingletonForTests() {
  inflight.clear();
  children.clear();
  hooksInstalled = false;
  stalePidCleanupDone = false;
}

export function forgetOpencodeServer(serverInfo) {
  if (serverInfo?.key) {
    inflight.delete(serverInfo.key);
    return;
  }
  for (const [key, value] of inflight.entries()) {
    if (value === serverInfo || value?.serverInfo === serverInfo) inflight.delete(key);
  }
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
  pidRecord = createDefaultPidRecord(env)
} = {}) {
  const directory = resolveOpencodeCwd({ cwd, env });
  const envPort = Number(env.RESONANTOS_OPENCODE_PORT);
  const explicitPort = Number.isInteger(port) && port > 0 ? port : (envPort > 0 ? envPort : 0);
  // Per-process runtime config is immutable for the bridge lifetime.
  const key = `${command}|${hostname}|${directory}|${explicitPort}`;
  if (inflight.has(key)) {
    const info = await inflight.get(key);
    if (await opencodeServerHealthy({ fetchImpl, baseUrl: info.baseUrl, headers: { Authorization: info.auth.header } })) {
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

  await cleanupStalePidOnce(pidRecord, directory);

  const startedAt = Date.now();
  const child = spawnImpl(command, ["serve", "--hostname", hostname, "--port", String(explicitPort)], {
    cwd: directory,
    env: { ...env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "ignore"]
  });
  children.add(child);
  child.once?.("exit", () => {
    children.delete(child);
    inflight.delete(key);
    try {
      Promise.resolve(pidRecord.clear(directory)).catch(() => {});
    } catch { /* noop */ }
  });

  const announcedPortPromise = waitForAnnouncedPort(child, explicitPort, maxWaitMs);
  const announcedPort = await announcedPortPromise;
  const baseUrl = opencodeBaseUrl({ hostname, port: announcedPort });
  const deadline = startedAt + maxWaitMs;
  while (true) {
    if (await opencodeServerHealthy({ fetchImpl, baseUrl, headers: { Authorization: header } })) {
      installShutdownHooks(processImpl);
      await pidRecord.write(directory, { pid: child.pid, port: announcedPort, startedAt: Date.now() });
      return { key, baseUrl, spawned: true, process: child, directory, auth: { username, password, header } };
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }

  try { child?.kill?.(); } catch { /* noop */ }
  throw new Error("OpenCode server did not become ready in time.");
}

function waitForAnnouncedPort(child, explicitPort, maxWaitMs) {
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
      if (explicitPort > 0) {
        finish(explicitPort);
        return;
      }
      try { child?.kill?.(); } catch { /* noop */ }
      if (!settled) {
        settled = true;
        reject(new Error("OpenCode server did not announce a listening port in time."));
      }
    }, maxWaitMs);
    child.stdout?.on?.("data", (chunk) => {
      if (settled) return;
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const match = buffer.match(/listening on https?:\/\/[^\s:/]+:(\d+)/i);
      if (match) finish(Number(match[1]));
    });
  });
}

async function cleanupStalePidOnce(pidRecord, directory) {
  if (stalePidCleanupDone) return;
  stalePidCleanupDone = true;
  const stale = await pidRecord.read(directory);
  if (stale?.pid && pidRecord.isAlive(stale.pid) && /opencode\s+serve/.test(pidRecord.commandOf(stale.pid))) {
    pidRecord.kill(stale.pid);
  }
}

function installShutdownHooks(processImpl) {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => {
    for (const child of children) {
      try { child?.kill?.(); } catch { /* noop */ }
    }
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

  const fetchWithTimeout = async (callName, url, init = {}, timeoutMs = requestTimeoutMs) => {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller && typeof setTimeoutImpl === "function"
      ? setTimeoutImpl(() => controller.abort(), timeoutMs)
      : null;
    try {
      return await fetchImpl(url, { ...init, signal: controller?.signal });
    } catch (error) {
      if (controller?.signal?.aborted || error?.name === "AbortError") {
        throw new Error(`opencode ${callName} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timer && typeof clearTimeoutImpl === "function") clearTimeoutImpl(timer);
    }
  };

  const loadApiDoc = async () => {
    if (docLoaded) return cachedDoc;
    if (docPromise) return docPromise;
    docPromise = (async () => {
      try {
        const res = await fetchWithTimeout("loadApiDoc", `${baseUrl}/doc`, { method: "GET", headers: { ...headers } });
        if (!res?.ok) return null;
        const text = await res.text().catch(() => "");
        cachedDoc = text ? JSON.parse(text) : null;
        docLoaded = true;
      } catch {
        cachedDoc = null;
      } finally {
        docPromise = null;
      }
      return cachedDoc;
    })();
    return docPromise;
  };

  const hasEndpoint = async (path, method) => {
    const doc = await loadApiDoc();
    return Boolean(doc?.paths?.[path]?.[String(method).toLowerCase()]);
  };

  const routeQuery = (extra = {}) => ({
    ...(pinnedDirectory ? { directory: pinnedDirectory } : {}),
    ...(workspace ? { workspace } : {}),
    ...extra
  });

  const call = async (callName, method, path, body, query, { timeoutMs = requestTimeoutMs } = {}) => {
    const fullPath = appendQuery(path, query);
    const res = await fetchWithTimeout(callName, `${baseUrl}${fullPath}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    }, timeoutMs);
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new Error(`opencode ${method} ${fullPath} failed: ${res.status} ${typeof data === "string" ? data : (data?.error ?? "")}`.trim());
    }
    return data;
  };

  return {
    createSession: (title = "ResonantOS session") => call("createSession", "POST", "/session", { title }, routeQuery()),
    prompt: async (sessionId, parts, { model, agent } = {}) => {
      const usesPromptAsync = await hasEndpoint("/session/{sessionID}/prompt_async", "POST");
      const path = usesPromptAsync
        ? `/session/${encodePathSegment(sessionId)}/prompt_async`
        : `/session/${encodePathSegment(sessionId)}/message`;
      const structuredModel = modelPayload(model);
      return call("prompt", "POST", path, {
        parts: textParts(parts),
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
