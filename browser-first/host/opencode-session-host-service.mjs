// Bridge routes for a live OpenCode session. Handlers delegate to the
// host-owned boundary; credentials and upstream URLs never leave that layer.
//
// GET /opencode/session/events is an SSE route. Transport writes the stream
// after this handler returns a Subscription (or a self-test {stream:true} marker).

import { OpenCodeBoundaryError } from "./opencode-boundary.mjs";
import { validateLoopbackHost } from "./bridge-server.mjs";

function bodyOf(req) {
  if (req && typeof req === "object" && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body;
  }
  return req && typeof req === "object" ? req : {};
}

function parseEventsSessionId(requestUrl) {
  let parsed;
  try {
    parsed = new URL(requestUrl ?? "", "http://127.0.0.1");
  } catch {
    throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
  }
  const keys = [...parsed.searchParams.keys()];
  const unique = [...new Set(keys)];
  if (unique.length !== 1 || unique[0] !== "sessionId") {
    throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
  }
  const values = parsed.searchParams.getAll("sessionId");
  if (values.length !== 1) throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
  const sessionId = values[0];
  if (typeof sessionId !== "string" || sessionId.length === 0 || Buffer.byteLength(sessionId) > 256) {
    throw new OpenCodeBoundaryError("OPENCODE_INVALID_REQUEST");
  }
  return sessionId;
}

export function createOpenCodeWebUrlHandler({ executionEnabled, appendAuditEntry } = {}) {
  if (typeof executionEnabled !== "function") {
    throw new Error("OpenCode web URL handler missing executionEnabled.");
  }
  if (typeof appendAuditEntry !== "function") {
    throw new Error("OpenCode web URL handler missing appendAuditEntry.");
  }
  return async function executeOpenCodeWebUrl() {
    if ((await executionEnabled()) !== true) {
      throw new OpenCodeBoundaryError("OPENCODE_EXECUTION_DISABLED");
    }
    await appendAuditEntry({
      at: new Date().toISOString(),
      addonId: "opencode",
      event: "webCockpitUrlIssued",
      url: "",
    });
    return { url: "", requiresCredential: true };
  };
}

export function createOpencodeSessionHostService(handlers = {}) {
  function required(name) {
    if (typeof handlers[name] !== "function") {
      throw new Error(`OpenCode session host service missing handler: ${name}`);
    }
    return handlers[name];
  }
  const routes = [
    { method: "POST", path: "/opencode/session/start", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionStart") },
    { method: "POST", path: "/opencode/session/prompt", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionPrompt") },
    { method: "POST", path: "/opencode/session/permission", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionPermission") },
    { method: "POST", path: "/opencode/session/stop", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionStop") },
    { method: "POST", path: "/opencode/sessions/list", requiredCapability: "addon-runtime-read", handler: required("executeOpenCodeSessionsList") },
    { method: "POST", path: "/opencode/session/messages", requiredCapability: "addon-runtime-read", handler: required("executeOpenCodeSessionMessages") },
    { method: "POST", path: "/opencode/session/abort", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionAbort") },
    { method: "POST", path: "/opencode/session/diff", requiredCapability: "addon-runtime-read", handler: required("executeOpenCodeSessionDiff") },
    { method: "POST", path: "/opencode/session/rename", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionRename") },
    { method: "POST", path: "/opencode/session/delete", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionDelete") },
    { method: "POST", path: "/opencode/session/archive", requiredCapability: "addon-runtime-control", handler: required("executeOpenCodeSessionArchive") },
    { method: "POST", path: "/opencode/agents/list", requiredCapability: "addon-runtime-read", handler: required("executeOpenCodeAgentsList") },
    {
      method: "GET",
      path: "/opencode/session/events",
      requiredCapability: "addon-runtime-read",
      responseType: "sse",
      handler: required("executeOpenCodeSessionEvents"),
    },
  ];
  return {
    opencodeSessionRoutes: routes.map((route) => ({ ...route, loopbackHostOnly: true })),
  };
}

export function createOpencodeSessionHandlers({ boundary } = {}) {
  if (
    !boundary
    || typeof boundary.run !== "function"
    || typeof boundary.validateEvents !== "function"
    || typeof boundary.openEvents !== "function"
  ) {
    throw new Error("OpenCode session handlers require a boundary.");
  }

  const run = (operation) => async (req) => boundary.run(operation, bodyOf(req));

  return {
    executeOpenCodeSessionStart: run("start"),
    executeOpenCodeSessionPrompt: run("prompt"),
    executeOpenCodeSessionPermission: run("permission"),
    executeOpenCodeSessionsList: run("list"),
    executeOpenCodeSessionMessages: run("messages"),
    executeOpenCodeSessionAbort: run("abort"),
    executeOpenCodeSessionDiff: run("diff"),
    executeOpenCodeSessionRename: run("rename"),
    executeOpenCodeSessionDelete: run("delete"),
    executeOpenCodeSessionArchive: run("archive"),
    executeOpenCodeAgentsList: run("agents"),
    executeOpenCodeSessionStop: run("stop"),
    executeOpenCodeSessionEvents: async (_payload, request) => {
      const sessionId = parseEventsSessionId(request?.url);
      if (!validateLoopbackHost(request ?? {}, request?.openCodeTransport ?? {})) {
        throw new OpenCodeBoundaryError("OPENCODE_HOST_REJECTED");
      }
      await boundary.validateEvents(sessionId);
      if (request?.selfTest === true) return { stream: true };
      return boundary.openEvents(sessionId);
    },
  };
}
