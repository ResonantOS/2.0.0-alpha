// Thin host-side client for a running `opencode serve` (its plain HTTP + SSE API),
// plus a lifecycle helper that ensures the server is up. Kept dependency-free
// (no @opencode-ai/sdk) — the server is a plain HTTP server — and fully
// dependency-injected so the lifecycle/state machine is unit-testable without
// spawning a real process.

const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";

export function opencodeBaseUrl({ hostname = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return `http://${hostname}:${port}`;
}

// Is a server already answering at baseUrl? Probes the OpenAPI doc (always
// present, needs no provider) with a short timeout.
export async function opencodeServerHealthy({ fetchImpl, baseUrl, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== "function") return false;
  try {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const res = await fetchImpl(`${baseUrl}/doc`, { signal: controller?.signal });
    if (timer) clearTimeout(timer);
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

// Ensure `opencode serve` is running at the resolved base URL. Reuses an already
// healthy server; otherwise spawns one and waits for it to answer. Returns
// { baseUrl, spawned, process|null }. Never throws for a benign "already up".
export async function ensureOpencodeServer({
  fetchImpl,
  spawnImpl,
  command,
  hostname = DEFAULT_HOST,
  port = DEFAULT_PORT,
  env = {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxWaitMs = 12000,
  pollMs = 300
} = {}) {
  const baseUrl = opencodeBaseUrl({ hostname, port });
  if (await opencodeServerHealthy({ fetchImpl, baseUrl })) {
    return { baseUrl, spawned: false, process: null };
  }
  if (!command || typeof spawnImpl !== "function") {
    throw new Error("OpenCode runtime is not available to start (no command resolved).");
  }
  const child = spawnImpl(command, ["serve", "--hostname", hostname, "--port", String(port)], {
    env: { ...env },
    stdio: "ignore"
  });
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await opencodeServerHealthy({ fetchImpl, baseUrl })) {
      return { baseUrl, spawned: true, process: child };
    }
  }
  try { child?.kill?.(); } catch { /* noop */ }
  throw new Error("OpenCode server did not become ready in time.");
}

// Minimal typed wrapper over the server's session endpoints.
export function createOpencodeHttpClient({ fetchImpl, baseUrl, headers = {} } = {}) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new Error(`opencode ${method} ${path} failed: ${res.status} ${typeof data === "string" ? data : (data?.error ?? "")}`.trim());
    }
    return data;
  };

  return {
    createSession: (title = "ResonantOS session") => call("POST", "/session", { title }),
    prompt: (sessionId, parts, { model, agent } = {}) =>
      call("POST", `/session/${encodeURIComponent(sessionId)}/message`, {
        parts: Array.isArray(parts) ? parts : [{ type: "text", text: String(parts ?? "") }],
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {})
      }),
    replyPermission: (sessionId, permissionId, decision) =>
      call("POST", `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
        response: decision?.approved ? true : false,
        ...(decision?.remember ? { remember: true } : {})
      }),
    listAgents: () => call("GET", "/agent"),
    eventUrl: () => `${baseUrl}/event`
  };
}
