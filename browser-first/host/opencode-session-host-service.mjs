// Bridge routes for a live OpenCode session, mirroring the host-service pattern.
// The route list is wired into the bridge; the handler logic (createOpencode
// SessionHandlers) is separated so it can be unit-tested against a fake client.
//
// The event stream (/opencode/session/events) is an SSE proxy of the server's
// /event bus; that streaming glue is bridge-server-specific and is registered
// alongside these request/response routes.

import { forgetOpencodeServer as defaultForgetOpencodeServer, opencodeServeBaseUrl } from "./opencode-client.mjs";

export function createOpenCodeWebUrlError(message) {
  const error = new Error(message);
  error.code = "opencode_web_url_execution_disabled";
  error.addonId = "opencode";
  error.event = "webCockpitUrlIssued";
  return error;
}

export function createOpenCodeWebUrlHandler({ executionEnabled, ensureServer, appendAuditEntry } = {}) {
  if (typeof executionEnabled !== "function") {
    throw new Error("OpenCode web URL handler missing executionEnabled.");
  }
  if (typeof ensureServer !== "function") {
    throw new Error("OpenCode web URL handler missing ensureServer.");
  }
  if (typeof appendAuditEntry !== "function") {
    throw new Error("OpenCode web URL handler missing appendAuditEntry.");
  }
  return async function executeOpenCodeWebUrl(req) {
    const payload = req?.body ?? req ?? {};
    if (!(await executionEnabled(payload))) {
      throw createOpenCodeWebUrlError("OpenCode web cockpit URL issuance requires explicit OpenCode execution enablement.");
    }
    const serverInfo = await ensureServer();
    const url = opencodeServeBaseUrl(serverInfo);
    await appendAuditEntry({
      at: new Date().toISOString(),
      addonId: "opencode",
      event: "webCockpitUrlIssued",
      url,
    });
    return serverInfo?.auth ? { url, requiresCredential: true } : { url };
  };
}

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
      {
        method: "POST",
        path: "/opencode/sessions/list",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeSessionsList"),
      },
      {
        method: "POST",
        path: "/opencode/session/messages",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeSessionMessages"),
      },
      {
        method: "POST",
        path: "/opencode/session/abort",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionAbort"),
      },
      {
        method: "POST",
        path: "/opencode/session/diff",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeSessionDiff"),
      },
      {
        method: "POST",
        path: "/opencode/session/rename",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionRename"),
      },
      {
        method: "POST",
        path: "/opencode/session/delete",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionDelete"),
      },
      {
        method: "POST",
        path: "/opencode/session/archive",
        requiredCapability: "addon-runtime-control",
        handler: required("executeOpenCodeSessionArchive"),
      },
      {
        method: "POST",
        path: "/opencode/agents/list",
        requiredCapability: "addon-runtime-read",
        handler: required("executeOpenCodeAgentsList"),
      },
    ],
  };
}

// Real handler logic, dependency-injected. `ensureServer()` brings up (or reuses)
// `opencode serve` and returns { baseUrl }; `createClient(baseUrl)` builds the
// HTTP client. A single client is memoized per bridge process.
export function createOpencodeSessionHandlers({ ensureServer, createClient, forgetOpencodeServer = defaultForgetOpencodeServer }) {
  let client = null;
  let serverInfo = null;

  async function ensureClient() {
    if (client) return client;
    serverInfo = await ensureServer();
    const opts = serverInfo?.auth?.header
      ? { directory: serverInfo.directory, headers: { Authorization: serverInfo.auth.header } }
      : { directory: serverInfo.directory };
    client = createClient(serverInfo.baseUrl, opts);
    return client;
  }

  const bodyOf = (req) => req?.body ?? req ?? {};

  return {
    executeOpenCodeSessionStart: async () => {
      const c = await ensureClient();
      const session = await c.createSession();
      const sessionId = session?.id ?? session?.sessionID ?? session?.sessionId ?? "";
      if (!sessionId) throw new Error("OpenCode did not return a session id.");
      const response = { ok: true, sessionId, eventUrl: c.eventUrl?.() ?? "", baseUrl: serverInfo?.baseUrl ?? "" };
      if (serverInfo?.auth?.header) response.eventAuthorization = serverInfo.auth.header;
      return response;
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
    executeOpenCodeSessionsList: async () => {
      const c = await ensureClient();
      const sessions = await c.listSessions();
      const response = {
        ok: true,
        eventUrl: c.eventUrl?.() ?? "",
        baseUrl: serverInfo?.baseUrl ?? "",
        sessions: (Array.isArray(sessions) ? sessions : []).map((s) => ({
          id: s.id ?? s.sessionID ?? "",
          title: s.title ?? "",
          created: s.time?.created ?? 0,
          updated: s.time?.updated ?? s.time?.created ?? 0
        })).filter((s) => s.id)
      };
      if (serverInfo?.auth?.header) response.eventAuthorization = serverInfo.auth.header;
      return response;
    },
    executeOpenCodeSessionMessages: async (req) => {
      const { sessionId } = bodyOf(req);
      if (!sessionId) throw new Error("messages requires sessionId.");
      const c = await ensureClient();
      const messages = await c.messages(sessionId);
      return { ok: true, messages: Array.isArray(messages) ? messages : [] };
    },
    executeOpenCodeSessionAbort: async (req) => {
      const { sessionId } = bodyOf(req);
      if (!sessionId) throw new Error("abort requires sessionId.");
      const c = await ensureClient();
      await c.abort(sessionId);
      return { ok: true };
    },
    executeOpenCodeSessionDiff: async (req) => {
      const { sessionId, messageID } = bodyOf(req);
      if (!sessionId) throw new Error("diff requires sessionId.");
      const c = await ensureClient();
      const diff = await c.sessionDiff(sessionId, { messageID });
      return { ok: true, diff: Array.isArray(diff) ? diff : [] };
    },
    executeOpenCodeSessionRename: async (req) => {
      const { sessionId, title } = bodyOf(req);
      if (!sessionId || !String(title ?? "").trim()) throw new Error("rename requires sessionId and title.");
      const c = await ensureClient();
      const session = await c.rename(sessionId, String(title).trim());
      return { ok: true, session };
    },
    executeOpenCodeSessionDelete: async (req) => {
      const { sessionId } = bodyOf(req);
      if (!sessionId) throw new Error("delete requires sessionId.");
      const c = await ensureClient();
      const deleted = await c.remove(sessionId);
      return { ok: true, deleted };
    },
    executeOpenCodeSessionArchive: async (req) => {
      const { sessionId, archived } = bodyOf(req);
      if (!sessionId) throw new Error("archive requires sessionId.");
      const c = await ensureClient();
      const session = await c.archive(sessionId, typeof archived === "number" ? archived : Date.now());
      return { ok: true, session };
    },
    executeOpenCodeAgentsList: async () => {
      const c = await ensureClient();
      const agents = await c.listAgents();
      return { ok: true, agents: Array.isArray(agents) ? agents : [] };
    },
    executeOpenCodeSessionStop: async () => {
      try { serverInfo?.process?.kill?.(); } catch { /* noop */ }
      try { forgetOpencodeServer?.(serverInfo); } catch {}
      client = null;
      serverInfo = null;
      return { ok: true };
    },
  };
}
