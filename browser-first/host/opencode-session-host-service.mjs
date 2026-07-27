// Bridge routes for a live OpenCode session, mirroring the host-service pattern.
// The route list is wired into the bridge; the handler logic (createOpencode
// SessionHandlers) is separated so it can be unit-tested against a fake client.
//
// The event stream (/opencode/session/events) is an SSE proxy of the server's
// /event bus; that streaming glue is bridge-server-specific and is registered
// alongside these request/response routes.

export function createOpencodeSessionHostService(handlers = {}) {
  function required(name) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`OpenCode session host service missing handler: ${name}`);
    }
    return handlers[name];
  }
  return {
    opencodeSessionRoutes: [
      {
        method: "POST",
        path: "/opencode/session/start",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionStart"),
      },
      {
        method: "POST",
        path: "/opencode/session/prompt",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionPrompt"),
      },
      {
        method: "POST",
        path: "/opencode/session/permission",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionPermission"),
      },
      {
        method: "POST",
        path: "/opencode/session/stop",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionStop"),
      },
    ],
  };
}

// Real handler logic, dependency-injected. `ensureServer()` brings up (or reuses)
// `opencode serve` and returns { baseUrl }; `createClient(baseUrl)` builds the
// HTTP client. A single client is memoized per bridge process.
export function createOpencodeSessionHandlers({ ensureServer, createClient }) {
  let client = null;
  let serverInfo = null;

  async function ensureClient() {
    if (client) return client;
    serverInfo = await ensureServer();
    client = createClient(serverInfo.baseUrl);
    return client;
  }

  const bodyOf = (req) => req?.body ?? req ?? {};

  return {
    executeOpenCodeSessionStart: async () => {
      const c = await ensureClient();
      const session = await c.createSession();
      const sessionId = session?.id ?? session?.sessionID ?? session?.sessionId ?? "";
      if (!sessionId) throw new Error("OpenCode did not return a session id.");
      return { ok: true, sessionId, eventUrl: c.eventUrl?.() ?? "", baseUrl: serverInfo?.baseUrl ?? "" };
    },
    executeOpenCodeSessionPrompt: async (req) => {
      const { sessionId, text, agent, model } = bodyOf(req);
      if (!sessionId || !String(text ?? "").trim()) throw new Error("prompt requires sessionId and text.");
      const c = await ensureClient();
      await c.prompt(sessionId, text, { agent, model });
      return { ok: true };
    },
    executeOpenCodeSessionPermission: async (req) => {
      const { sessionId, permissionId, decision } = bodyOf(req);
      if (!sessionId || !permissionId) throw new Error("permission reply requires sessionId and permissionId.");
      const c = await ensureClient();
      await c.replyPermission(sessionId, permissionId, decision ?? {});
      return { ok: true };
    },
    executeOpenCodeSessionStop: async () => {
      try { serverInfo?.process?.kill?.(); } catch { /* noop */ }
      client = null;
      serverInfo = null;
      return { ok: true };
    },
  };
}
