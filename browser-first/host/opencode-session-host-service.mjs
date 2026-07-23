const EVENT_BUFFER_LIMIT = 500;
const EVENT_BUFFER_BYTES_LIMIT = 1_048_576;
const EVENT_PAYLOAD_BYTES_LIMIT = 32_768;
const EVENT_TEXT_LIMIT = 8_192;
const EVENT_COLLECTION_LIMIT = 100;
const EVENT_REDACTION_LOOKAHEAD_LIMIT = 16_384;
const EVENT_DELTA_STREAM_LIMIT = 100;
const START_EVENT_LIMIT = 8;
const PREFLIGHT_REVOKED_CODE = "OPENCODE_PREFLIGHT_REVOKED";

const SESSION_STATE = Object.freeze({
  FAILED: "failed",
  RUNNING: "running",
  STARTING: "starting",
  STOPPED: "stopped",
});

function requiredFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`OpenCode session controller missing dependency: ${name}`);
  }
  return value;
}

function requestBody(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return {};
  if (request.body && typeof request.body === "object" && !Array.isArray(request.body)) {
    return request.body;
  }
  return request;
}

function privatePreflightPayload(payload) {
  const workspacePath = payload.workspacePath ?? payload.workspace;
  return workspacePath === undefined ? {} : { workspacePath };
}

function sessionIdFrom(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAbsolutePathLike(value) {
  return value.startsWith("/")
    || value.startsWith("\\")
    || /^[a-z]:[\\/]/i.test(value)
    || /^file:/i.test(value);
}

function lifecycleProcess(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return null;
  return lifecycle.process ?? lifecycle.childProcess ?? lifecycle.child ?? null;
}

function sessionIdFromResult(result) {
  return sessionIdFrom(result?.id ?? result?.sessionID ?? result?.sessionId);
}

function eventIterable(source) {
  const candidate = source?.stream ?? source?.events ?? source;
  return candidate && typeof candidate[Symbol.asyncIterator] === "function"
    ? candidate
    : null;
}

function permissionRequestId(event) {
  if (event?.type !== "permission.v2.asked") return "";
  return typeof event?.data?.id === "string" ? event.data.id.trim() : "";
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function boundedString(value, limit = 256) {
  if (typeof value !== "string") return "";
  return value.slice(0, limit);
}

function sensitiveValues(attempt) {
  const values = new Set();
  const visit = (value, key = "", inheritedSensitive = false, depth = 0) => {
    if (depth > 4 || value === null || value === undefined) return;
    const sensitive = inheritedSensitive
      || /(?:api.?key|authorization|credential|password|secret|token)/i.test(key);
    if (typeof value === "string") {
      if (sensitive && value.length >= 4) values.add(value);
      return;
    }
    if (typeof value !== "object") return;
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      visit(
        nestedValue,
        nestedKey,
        sensitive || /credentials?/i.test(key),
        depth + 1,
      );
    }
  };
  visit(attempt.preflightResult);
  visit(attempt.lifecycle);
  return [...values].sort((left, right) => right.length - left.length);
}

function createExactTextRedactor(rules) {
  const exactRules = [];
  const seen = new Set();
  for (const rule of rules) {
    const value = typeof rule?.value === "string"
      ? rule.value.slice(0, EVENT_REDACTION_LOOKAHEAD_LIMIT)
      : "";
    if (value.length < 4 || seen.has(value)) continue;
    seen.add(value);
    exactRules.push({
      replacement: typeof rule.replacement === "string"
        ? rule.replacement
        : "[redacted]",
      value,
    });
  }
  exactRules.sort((left, right) => right.value.length - left.value.length);
  let pending = "";

  const drainSafeText = () => {
    let output = "";
    while (pending) {
      const match = exactRules.find((rule) => pending.startsWith(rule.value));
      if (match) {
        output += match.replacement;
        pending = pending.slice(match.value.length);
        continue;
      }
      if (exactRules.some((rule) => rule.value.startsWith(pending))) break;
      output += pending[0];
      pending = pending.slice(1);
    }
    return output;
  };

  return {
    hasPending() {
      return pending.length > 0;
    },
    write(value) {
      if (typeof value !== "string" || !value) return "";
      pending += value;
      return drainSafeText();
    },
    flush() {
      let output = drainSafeText();
      if (!pending) return output;
      const partialRule = exactRules.find((rule) => (
        rule.value.startsWith(pending)
      ));
      output += partialRule && pending.length >= 4
        ? partialRule.replacement
        : pending;
      pending = "";
      return output;
    },
  };
}

function createAttemptTextRedactor(attempt) {
  const home = attempt.preflightResult?.childEnvironment?.HOME
    ?? attempt.preflightResult?.scopedEnvironment?.HOME;
  return createExactTextRedactor([
    ...sensitiveValues(attempt).map((value) => ({
      value,
      replacement: "[redacted]",
    })),
    { value: attempt.workspace, replacement: "." },
    { value: typeof home === "string" ? home : "", replacement: "~" },
  ]);
}

function redactTruncatedExactValue(text, exactValue, replacement) {
  if (exactValue.length < 4) return text;
  const prefix = exactValue.slice(0, 4);
  for (
    let start = text.lastIndexOf(prefix);
    start >= 0;
    start = text.lastIndexOf(prefix, start - 1)
  ) {
    const fragment = text.slice(start);
    if (fragment.length < exactValue.length && exactValue.startsWith(fragment)) {
      return `${text.slice(0, start)}${replacement}`;
    }
  }
  return text;
}

function redactEventText(value, attempt, limit = EVENT_TEXT_LIMIT) {
  if (typeof value !== "string" || !value) return "";
  const secrets = sensitiveValues(attempt);
  const home = attempt.preflightResult?.childEnvironment?.HOME
    ?? attempt.preflightResult?.scopedEnvironment?.HOME;
  const exactValues = [
    ...secrets,
    attempt.workspace,
    typeof home === "string" ? home : "",
  ].filter(Boolean);
  const lookahead = Math.min(
    EVENT_REDACTION_LOOKAHEAD_LIMIT,
    Math.max(512, ...exactValues.map((entry) => entry.length)),
  );
  let text = value.slice(0, limit + lookahead);

  const lifecycleRedactor = attempt.lifecycle?.redactSensitiveText;
  if (typeof lifecycleRedactor === "function") {
    try {
      text = lifecycleRedactor.call(attempt.lifecycle, text, "[redacted]");
    } catch {
      return "[redacted]";
    }
  }
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
  }
  if (attempt.workspace) {
    text = text.split(attempt.workspace).join(".");
  }
  if (typeof home === "string" && home) {
    text = text.split(home).join("~");
  }

  text = text
    .replace(/sk-[a-z0-9_-]+/gi, "[redacted-key]")
    .replace(/bearer\s+[a-z0-9._-]+/gi, "Bearer [redacted-token]")
    .replace(/api[_-]?key\s*[:=]\s*[^\s]+/gi, "api_key=[redacted]")
    .replace(/token\s*[:=]\s*[^\s]+/gi, "token=[redacted]")
    .replace(/secret\s*[:=]\s*[^\s]+/gi, "secret=[redacted]")
    .replace(/password\s*[:=]\s*[^\s]+/gi, "password=[redacted]")
    .replace(/credential\s*[:=]\s*[^\s]+/gi, "credential=[redacted]")
    .replace(/authorization\s*[:=]\s*[^\s]+/gi, "authorization=[redacted]")
    .replace(/basic\s+[a-z0-9+/=_-]+/gi, "Basic [redacted-token]")
    .replace(/\b[a-z]:[\\/][^\s"'`]+/gi, "[redacted-path]")
    .replace(/(^|[\s("'=])\/(?!\/)[^\s"'`]+/g, "$1[redacted-path]")
    .slice(0, limit);

  for (const secret of secrets) {
    text = redactTruncatedExactValue(text, secret, "[redacted]");
  }
  if (attempt.workspace) {
    text = redactTruncatedExactValue(text, attempt.workspace, ".");
  }
  if (typeof home === "string" && home) {
    text = redactTruncatedExactValue(text, home, "~");
  }
  return text.slice(0, limit);
}

function redactEventPath(value, attempt) {
  const raw = boundedString(value, 2_048).trim();
  if (!raw) return "";
  const workspace = attempt.workspace;
  if (workspace) {
    if (raw === workspace) return ".";
    for (const separator of ["/", "\\"]) {
      const prefix = `${workspace}${separator}`;
      if (raw.startsWith(prefix)) {
        return raw.slice(prefix.length).replaceAll("\\", "/");
      }
    }
  }
  if (isAbsolutePathLike(raw)) return "[redacted-path]";
  return redactEventText(raw, attempt, 2_048);
}

function sanitizeJsonValue(value, attempt, depth = 0) {
  if (depth > 4 || value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactEventText(value, attempt, 2_048);
  if (Array.isArray(value)) {
    return value
      .slice(0, EVENT_COLLECTION_LIMIT)
      .map((entry) => sanitizeJsonValue(entry, attempt, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (typeof value !== "object") return String(value).slice(0, 256);

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value).slice(
    0,
    EVENT_COLLECTION_LIMIT,
  )) {
    const sanitizedKey = redactEventText(key, attempt, 256).trim()
      || "[redacted-key]";
    if (/(?:api.?key|authorization|credential|password|secret|token)/i.test(key)) {
      Object.defineProperty(sanitized, sanitizedKey, {
        configurable: true,
        enumerable: true,
        value: "[redacted]",
        writable: true,
      });
      continue;
    }
    const next = sanitizeJsonValue(nestedValue, attempt, depth + 1);
    if (next !== undefined) {
      Object.defineProperty(sanitized, sanitizedKey, {
        configurable: true,
        enumerable: true,
        value: next,
        writable: true,
      });
    }
  }
  return sanitized;
}

function sanitizeOpenCodeEvent(event, attempt) {
  const source = objectValue(event);
  const type = boundedString(source?.type, 128);
  const data = objectValue(source?.data);
  if (!type || !data || data.sessionID !== attempt.sessionId) return null;

  const sessionID = attempt.sessionId;
  const required = (value, limit = 256) => {
    const result = boundedString(value, limit).trim();
    return result || null;
  };
  const deltaEvent = (idKey) => {
    const id = required(data[idKey]);
    if (!id || typeof data.delta !== "string") return null;
    return {
      type,
      data: {
        sessionID,
        ...(idKey === "textID"
          ? { assistantMessageID: required(data.assistantMessageID) ?? "", textID: id }
          : idKey === "reasoningID"
            ? {
                assistantMessageID: required(data.assistantMessageID) ?? "",
                reasoningID: id,
              }
            : {
                messageID: required(data.messageID) ?? "",
                partID: id,
                field: data.field,
              }),
        delta: redactEventText(data.delta, attempt),
      },
    };
  };

  let sanitized = null;
  switch (type) {
    case "session.next.text.delta":
      sanitized = deltaEvent("textID");
      break;
    case "session.next.reasoning.delta":
      sanitized = deltaEvent("reasoningID");
      break;
    case "message.part.delta":
      if (data.field !== "text" && data.field !== "reasoning") return null;
      sanitized = deltaEvent("partID");
      break;
    case "session.next.tool.called": {
      const callID = required(data.callID);
      const tool = required(data.tool);
      const input = objectValue(data.input);
      if (!callID || !tool || !input) return null;
      sanitized = {
        type,
        data: {
          sessionID,
          assistantMessageID: required(data.assistantMessageID) ?? "",
          callID,
          tool,
          input: sanitizeJsonValue(input, attempt),
        },
      };
      break;
    }
    case "session.next.tool.success": {
      const callID = required(data.callID);
      if (!callID) return null;
      sanitized = {
        type,
        data: {
          sessionID,
          assistantMessageID: required(data.assistantMessageID) ?? "",
          callID,
          result: sanitizeJsonValue(data.result ?? data.content ?? "", attempt),
        },
      };
      break;
    }
    case "session.next.tool.failed": {
      const callID = required(data.callID);
      if (!callID) return null;
      sanitized = {
        type,
        data: {
          sessionID,
          assistantMessageID: required(data.assistantMessageID) ?? "",
          callID,
          error: sanitizeJsonValue(data.error ?? "failed", attempt),
        },
      };
      break;
    }
    case "session.diff": {
      if (!Array.isArray(data.diff)) return null;
      const diff = [];
      for (const candidate of data.diff.slice(0, EVENT_COLLECTION_LIMIT)) {
        const file = objectValue(candidate);
        const filePath = redactEventPath(file?.file, attempt);
        if (
          !filePath
          || filePath === "[redacted-path]"
          || !Number.isFinite(file?.additions)
          || !Number.isFinite(file?.deletions)
        ) {
          continue;
        }
        diff.push({
          file: filePath,
          additions: file.additions,
          deletions: file.deletions,
          ...(file.status === "added"
            || file.status === "deleted"
            || file.status === "modified"
            ? { status: file.status }
            : {}),
        });
      }
      sanitized = { type, data: { sessionID, diff } };
      break;
    }
    case "permission.v2.asked": {
      const id = required(data.id);
      const action = required(data.action);
      if (
        !id
        || !action
        || !Array.isArray(data.resources)
        || data.resources.some((resource) => typeof resource !== "string")
      ) {
        return null;
      }
      sanitized = {
        type,
        data: {
          id,
          sessionID,
          action,
          resources: data.resources
            .slice(0, EVENT_COLLECTION_LIMIT)
            .map((resource) => redactEventText(resource, attempt, 1_024)),
        },
      };
      break;
    }
    case "permission.v2.replied": {
      const requestID = required(data.requestID);
      if (!requestID) return null;
      sanitized = {
        type,
        data: {
          sessionID,
          requestID,
          ...(data.reply === "once"
            || data.reply === "always"
            || data.reply === "reject"
            ? { reply: data.reply }
            : {}),
        },
      };
      break;
    }
    case "todo.updated": {
      if (!Array.isArray(data.todos)) return null;
      const todos = [];
      for (const candidate of data.todos.slice(0, EVENT_COLLECTION_LIMIT)) {
        const todo = objectValue(candidate);
        const content = required(todo?.content, 1_024);
        const status = required(todo?.status, 64);
        if (!content || !status) return null;
        todos.push({
          content: redactEventText(content, attempt, 1_024),
          status,
          ...(required(todo.priority, 64) ? { priority: required(todo.priority, 64) } : {}),
        });
      }
      sanitized = { type, data: { sessionID, todos } };
      break;
    }
    case "session.created":
    case "session.updated": {
      const info = objectValue(data.info);
      if (!info || required(info.id) !== sessionID) return null;
      const model = objectValue(info.model);
      sanitized = {
        type,
        data: {
          sessionID,
          info: {
            id: sessionID,
            title: redactEventText(info.title ?? "", attempt, 1_024),
            agent: required(info.agent) ?? "",
            ...(model && required(model.providerID) && required(model.id)
              ? {
                  model: {
                    providerID: required(model.providerID),
                    id: required(model.id),
                  },
                }
              : {}),
          },
        },
      };
      break;
    }
    case "session.status": {
      const status = objectValue(data.status);
      if (!status || !["busy", "idle", "retry"].includes(status.type)) return null;
      sanitized = { type, data: { sessionID, status: { type: status.type } } };
      break;
    }
    case "session.idle":
      sanitized = { type, data: { sessionID } };
      break;
    default:
      return null;
  }

  return Buffer.byteLength(JSON.stringify(sanitized), "utf8")
    <= EVENT_PAYLOAD_BYTES_LIMIT
    ? sanitized
    : null;
}

function processSupportsExitEvents(processHandle) {
  return typeof processHandle?.once === "function"
    || typeof processHandle?.addEventListener === "function";
}

function addProcessExitListener(processHandle, listener) {
  if (typeof processHandle?.once === "function") {
    processHandle.once("exit", listener);
    return () => {
      if (typeof processHandle.off === "function") processHandle.off("exit", listener);
      else processHandle.removeListener?.("exit", listener);
    };
  }
  processHandle.addEventListener("exit", listener, { once: true });
  return () => processHandle.removeEventListener?.("exit", listener);
}

function clearLifecycleSecrets(lifecycle) {
  if (!lifecycle || typeof lifecycle !== "object") return;
  for (const key of ["authorization", "credential", "credentials", "password", "username"]) {
    if (!Object.hasOwn(lifecycle, key)) continue;
    const value = lifecycle[key];
    if (value && typeof value === "object") {
      for (const nestedKey of Object.keys(value)) {
        try {
          value[nestedKey] = "";
        } catch {
          // Dropping the controller's reference is sufficient for opaque handles.
        }
      }
    }
    try {
      lifecycle[key] = null;
    } catch {
      // Lifecycle adapters own any immutable credential storage they return.
    }
  }
}

function isExplicitRevocation(error) {
  return error?.code === PREFLIGHT_REVOKED_CODE || error?.revoked === true;
}

export function createOpencodeSessionHostService(handlers = {}) {
  function requiredHandler(name) {
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
        handler: requiredHandler("executeOpenCodeSessionStart"),
      },
      {
        method: "POST",
        path: "/opencode/session/prompt",
        requiredCapability: "addon-runtime-control",
        handler: requiredHandler("executeOpenCodeSessionPrompt"),
      },
      {
        method: "POST",
        path: "/opencode/session/permission",
        requiredCapability: "addon-runtime-control",
        handler: requiredHandler("executeOpenCodeSessionPermission"),
      },
      {
        method: "POST",
        path: "/opencode/session/events",
        requiredCapability: "addon-runtime-read",
        handler: requiredHandler("executeOpenCodeSessionEvents"),
      },
      {
        method: "POST",
        path: "/opencode/session/stop",
        requiredCapability: "addon-runtime-control",
        handler: requiredHandler("executeOpenCodeSessionStop"),
      },
    ],
  };
}

// preflight owns workspace/model policy; start/stopLifecycle own exactly one
// returned child; createClient supplies the narrow SDK adapter used below.
export function createOpencodeSessionHandlers({
  createAbortController = () => new AbortController(),
  createClient,
  disposeClient,
  preflight,
  redactWorkspace,
  startLifecycle,
  stopLifecycle,
} = {}) {
  const runPreflightDependency = requiredFunction("preflight", preflight);
  const startOwnedLifecycle = requiredFunction("startLifecycle", startLifecycle);
  const stopOwnedLifecycle = requiredFunction("stopLifecycle", stopLifecycle);
  const createSdkClient = requiredFunction("createClient", createClient);
  const redactOwnedWorkspace = requiredFunction("redactWorkspace", redactWorkspace);
  const newAbortController = requiredFunction("createAbortController", createAbortController);

  let state = SESSION_STATE.STOPPED;
  let currentAttempt = null;
  let startInFlight = null;
  let cleanupBarrier = Promise.resolve();
  let cleanupFailure = null;
  let shutdownGeneration = 0;
  let shutdownInProgress = 0;
  let bridgeShutdownRequested = false;

  async function disposeSdkClient(client) {
    if (!client) return;
    if (typeof disposeClient === "function") {
      await disposeClient(client);
      return;
    }
    if (typeof client.dispose === "function") {
      await client.dispose();
      return;
    }
    if (typeof client.close === "function") await client.close();
  }

  async function releaseLifecycle(lifecycle, context) {
    if (!lifecycle) return;
    try {
      await stopOwnedLifecycle(lifecycle, context);
    } catch (error) {
      cleanupFailure ??= error;
      throw error;
    } finally {
      clearLifecycleSecrets(lifecycle);
    }
  }

  async function disposeAttempt(attempt, {
    reason,
    terminalState,
    terminate,
  }) {
    if (!attempt) return;
    if (attempt.cleanupPromise) return attempt.cleanupPromise;

    attempt.disposed = true;
    const abortController = attempt.abortController;
    const client = attempt.client;
    const detachProcessExit = attempt.detachProcessExit;
    const lifecycle = attempt.lifecycle;
    const pendingStart = startInFlight?.attempt === attempt
      ? startInFlight.promise
      : null;

    attempt.abortController = null;
    attempt.client = null;
    attempt.detachProcessExit = null;
    attempt.lifecycle = null;
    attempt.process = null;
    attempt.sessionId = "";
    attempt.workspace = "";
    attempt.publicWorkspace = "";
    attempt.model = "";
    attempt.preflightResult = null;
    attempt.publicResult = null;
    attempt.events.length = 0;
    attempt.deltaStreams.clear();
    attempt.eventBytes = 0;
    attempt.permissionRequests.clear();
    attempt.pendingStartEvents.length = 0;
    attempt.cursor = 0;
    attempt.droppedBefore = 0;

    if (currentAttempt === attempt) {
      currentAttempt = null;
      state = terminalState;
    }
    if (startInFlight?.attempt === attempt) startInFlight = null;

    try {
      detachProcessExit?.();
    } catch {
      // The owned process may already have completed its event dispatch.
    }
    try {
      abortController?.abort(reason);
    } catch {
      // Cleanup continues even if an injected AbortController is non-standard.
    }

    attempt.cleanupPromise = (async () => {
      let clientError = null;
      try {
        await disposeSdkClient(client);
      } catch (error) {
        clientError = error;
      }
      try {
        await releaseLifecycle(lifecycle, { reason, terminate });
      } catch (error) {
        if (!clientError) clientError = error;
      }
      if (clientError) throw clientError;
    })();
    const observedCleanup = attempt.cleanupPromise.catch((error) => {
      cleanupFailure ??= error;
    });
    cleanupBarrier = pendingStart
      ? Promise.allSettled([observedCleanup, pendingStart]).then(() => undefined)
      : observedCleanup;

    return attempt.cleanupPromise;
  }

  async function failAttempt(attempt, reason, terminate = true) {
    try {
      await disposeAttempt(attempt, {
        reason,
        terminalState: SESSION_STATE.FAILED,
        terminate,
      });
    } catch {
      // The state is already fail-closed; asynchronous cleanup has no caller.
    }
  }

  function normalizePreflight(result) {
    if (
      !result
      || result.allowed === false
      || result.authorized === false
      || result.revoked === true
    ) {
      const error = new Error("OpenCode session preflight authorization was revoked.");
      error.code = PREFLIGHT_REVOKED_CODE;
      throw error;
    }

    const workspace = typeof (result.workspace ?? result.directory ?? result.workspacePath) === "string"
      ? (result.workspace ?? result.directory ?? result.workspacePath).trim()
      : "";
    if (!workspace) {
      throw new Error("OpenCode session preflight did not return an owned workspace.");
    }

    const model = typeof result.model === "string" ? result.model.trim() : "";
    if (!model) {
      throw new Error("OpenCode session preflight did not select a host model.");
    }

    const publicWorkspace = String(redactOwnedWorkspace(workspace, result) ?? "").trim();
    if (
      !publicWorkspace
      || publicWorkspace === workspace
      || isAbsolutePathLike(publicWorkspace)
    ) {
      throw new Error("OpenCode session preflight did not return a redacted workspace.");
    }

    return {
      model,
      publicWorkspace,
      raw: result,
      workspace,
    };
  }

  async function runPreflight(payload, operation) {
    const input = privatePreflightPayload(payload);
    const result = await runPreflightDependency(input, { operation });
    return normalizePreflight(result);
  }

  function requireOwnedAttempt(payload) {
    const requestedSessionId = sessionIdFrom(payload.sessionId ?? payload.sessionID);
    if (!requestedSessionId) {
      throw new Error("OpenCode operation requires the active sessionId.");
    }
    if (!currentAttempt || state !== SESSION_STATE.RUNNING || !currentAttempt.sessionId) {
      throw new Error("There is no active OpenCode session.");
    }
    if (requestedSessionId !== currentAttempt.sessionId) {
      throw new Error("OpenCode session is not owned by this bridge.");
    }
    return currentAttempt;
  }

  async function revalidateOwnedAttempt(attempt, operation) {
    let checked;
    try {
      checked = await runPreflightDependency(
        { workspacePath: attempt.workspace },
        { operation, sessionId: attempt.sessionId },
      );
      checked = normalizePreflight(checked);
      if (checked.workspace !== attempt.workspace) {
        const error = new Error("OpenCode session workspace ownership was revoked.");
        error.code = PREFLIGHT_REVOKED_CODE;
        throw error;
      }
    } catch (error) {
      await disposeAttempt(attempt, {
        reason: `preflight-${operation}`,
        terminalState: SESSION_STATE.FAILED,
        terminate: true,
      }).catch(() => undefined);
      throw error;
    }

    if (
      attempt.disposed
      || currentAttempt !== attempt
      || state !== SESSION_STATE.RUNNING
    ) {
      throw new Error("There is no active OpenCode session.");
    }
    return checked;
  }

  function appendEvent(attempt, event) {
    const sanitizedEvent = sanitizeOpenCodeEvent(event, attempt);
    if (!sanitizedEvent) return;
    const bytes = Buffer.byteLength(JSON.stringify(sanitizedEvent), "utf8");
    attempt.cursor += 1;
    const entry = { bytes, cursor: attempt.cursor, event: sanitizedEvent };
    attempt.events.push(entry);
    attempt.eventBytes += bytes;

    const requestID = permissionRequestId(sanitizedEvent);
    if (requestID) {
      attempt.permissionRequests.set(requestID, {
        cursor: entry.cursor,
        requestID,
      });
    }

    while (
      attempt.events.length > EVENT_BUFFER_LIMIT
      || attempt.eventBytes > EVENT_BUFFER_BYTES_LIMIT
    ) {
      const dropped = attempt.events.shift();
      attempt.eventBytes -= dropped.bytes;
      attempt.droppedBefore = dropped.cursor;
      const droppedRequestID = permissionRequestId(dropped.event);
      if (
        droppedRequestID
        && attempt.permissionRequests.get(droppedRequestID)?.cursor === dropped.cursor
      ) {
        attempt.permissionRequests.delete(droppedRequestID);
      }
    }
  }

  function prepareDeltaEvent(attempt, event) {
    const source = objectValue(event);
    const data = objectValue(source?.data);
    const type = boundedString(source?.type, 128);
    let key = "";
    if (type === "session.next.text.delta") {
      key = `${type}:${boundedString(data?.assistantMessageID, 256)}:${boundedString(data?.textID, 256)}`;
    } else if (type === "session.next.reasoning.delta") {
      key = `${type}:${boundedString(data?.assistantMessageID, 256)}:${boundedString(data?.reasoningID, 256)}`;
    } else if (type === "message.part.delta") {
      key = `${type}:${boundedString(data?.messageID, 256)}:${boundedString(data?.partID, 256)}:${boundedString(data?.field, 64)}`;
    } else {
      return event;
    }
    if (
      data?.sessionID !== attempt.sessionId
      || typeof data.delta !== "string"
      || key.includes("::")
    ) {
      return null;
    }

    let stream = attempt.deltaStreams.get(key);
    if (!stream) {
      if (attempt.deltaStreams.size >= EVENT_DELTA_STREAM_LIMIT) return null;
      let lifecycleRedactor = null;
      if (typeof attempt.lifecycle?.createSensitiveTextRedactor === "function") {
        lifecycleRedactor = attempt.lifecycle.createSensitiveTextRedactor(
          "[redacted]",
        );
        if (
          !lifecycleRedactor
          || typeof lifecycleRedactor.write !== "function"
          || typeof lifecycleRedactor.flush !== "function"
        ) {
          throw new Error("OpenCode lifecycle returned an invalid sensitive text redactor.");
        }
      }
      stream = {
        event: source,
        hostRedactor: createAttemptTextRedactor(attempt),
        lifecycleRedactor,
      };
      attempt.deltaStreams.set(key, stream);
    } else {
      stream.event = source;
    }

    const boundedDelta = data.delta.slice(
      0,
      EVENT_TEXT_LIMIT + EVENT_REDACTION_LOOKAHEAD_LIMIT,
    );
    const hostOutput = stream.hostRedactor.write(boundedDelta);
    const output = stream.lifecycleRedactor
      ? stream.lifecycleRedactor.write(hostOutput)
      : hostOutput;
    if (
      !stream.hostRedactor.hasPending()
      && (
        !stream.lifecycleRedactor
        || (
          typeof stream.lifecycleRedactor.hasPending === "function"
          && !stream.lifecycleRedactor.hasPending()
        )
      )
    ) {
      attempt.deltaStreams.delete(key);
    }
    if (!output) return null;
    return {
      ...source,
      data: {
        ...data,
        delta: output,
      },
    };
  }

  function flushDeltaStreams(attempt) {
    for (const stream of attempt.deltaStreams.values()) {
      let output = stream.hostRedactor.flush();
      if (stream.lifecycleRedactor) {
        output = stream.lifecycleRedactor.write(output)
          + stream.lifecycleRedactor.flush();
      }
      if (output) {
        appendEvent(attempt, {
          ...stream.event,
          data: {
            ...stream.event.data,
            delta: output,
          },
        });
      }
    }
    attempt.deltaStreams.clear();
  }

  function recordEvent(attempt, event) {
    if (
      attempt.disposed
      || currentAttempt !== attempt
    ) {
      return;
    }

    const source = objectValue(event);
    const data = objectValue(source?.data);
    if (state === SESSION_STATE.STARTING) {
      const candidateSessionId = source?.type === "session.created"
        ? sessionIdFrom(data?.sessionID)
        : "";
      if (
        candidateSessionId
        && attempt.pendingStartEvents.length < START_EVENT_LIMIT
      ) {
        const sanitized = sanitizeOpenCodeEvent(source, {
          ...attempt,
          sessionId: candidateSessionId,
        });
        if (sanitized) {
          attempt.pendingStartEvents.push({
            event: sanitized,
            sessionId: candidateSessionId,
          });
        }
      }
      return;
    }
    if (state !== SESSION_STATE.RUNNING) return;

    const isIdleBoundary = data?.sessionID === attempt.sessionId
      && (
        source?.type === "session.idle"
        || (
          source?.type === "session.status"
          && objectValue(data.status)?.type === "idle"
        )
      );
    if (isIdleBoundary) flushDeltaStreams(attempt);

    const preparedEvent = prepareDeltaEvent(attempt, event);
    if (preparedEvent) appendEvent(attempt, preparedEvent);
  }

  async function consumeEvents(attempt, source) {
    try {
      for await (const event of source) recordEvent(attempt, event);
      if (!attempt.abortController?.signal.aborted && !attempt.disposed) {
        await failAttempt(attempt, "event-pump-ended", true);
      }
    } catch {
      if (!attempt.abortController?.signal.aborted && !attempt.disposed) {
        await failAttempt(attempt, "event-pump-failed", true);
      }
    }
  }

  async function createRunningSession(attempt) {
    try {
      const lifecycle = await startOwnedLifecycle({
        directory: attempt.workspace,
        model: attempt.model,
        preflight: attempt.preflightResult,
        workspace: attempt.workspace,
      });
      if (attempt.disposed || currentAttempt !== attempt) {
        await releaseLifecycle(lifecycle, {
          reason: "start-cancelled",
          terminate: true,
        });
        throw new Error("OpenCode session start was cancelled.");
      }

      attempt.lifecycle = lifecycle;
      attempt.process = lifecycleProcess(lifecycle);
      if (!attempt.process || !processSupportsExitEvents(attempt.process)) {
        throw new Error("OpenCode lifecycle did not return an owned process handle.");
      }
      if (attempt.process.exitCode !== null && attempt.process.exitCode !== undefined) {
        throw new Error("OpenCode owned process exited before session creation.");
      }

      const onExit = () => {
        void failAttempt(attempt, "owned-process-exit", false);
      };
      attempt.detachProcessExit = addProcessExitListener(attempt.process, onExit);

      const client = await createSdkClient({
        directory: attempt.workspace,
        lifecycle,
        model: attempt.model,
      });
      if (attempt.disposed || currentAttempt !== attempt) {
        await disposeSdkClient(client);
        throw new Error("OpenCode session start was cancelled.");
      }
      attempt.client = client;

      for (const method of [
        "createSession",
        "prompt",
        "replyPermission",
        "subscribeEvents",
      ]) {
        if (typeof client?.[method] !== "function") {
          throw new Error(`OpenCode SDK adapter is missing ${method}.`);
        }
      }

      const abortController = newAbortController();
      if (!abortController?.signal || typeof abortController.abort !== "function") {
        throw new Error("OpenCode session controller requires a valid AbortController.");
      }
      attempt.abortController = abortController;
      const source = eventIterable(await client.subscribeEvents({
        signal: abortController.signal,
      }));
      if (!source) {
        throw new Error("OpenCode SDK adapter did not return an async event stream.");
      }
      if (attempt.disposed || currentAttempt !== attempt) {
        throw new Error("OpenCode session start was cancelled.");
      }

      attempt.pumpPromise = consumeEvents(attempt, source);
      const session = await client.createSession({
        directory: attempt.workspace,
        model: attempt.model,
      });
      const sessionId = sessionIdFromResult(session);
      if (!sessionId) throw new Error("OpenCode did not return a session id.");
      if (attempt.disposed || currentAttempt !== attempt) {
        throw new Error("OpenCode session start was cancelled.");
      }
      attempt.sessionId = sessionId;

      state = SESSION_STATE.RUNNING;
      for (const pending of attempt.pendingStartEvents.splice(0)) {
        if (pending.sessionId === sessionId) appendEvent(attempt, pending.event);
      }
      attempt.publicResult = Object.freeze({
        sessionId,
        workspace: attempt.publicWorkspace,
      });
      return { ...attempt.publicResult };
    } catch (error) {
      await disposeAttempt(attempt, {
        reason: "start-failed",
        terminalState: SESSION_STATE.FAILED,
        terminate: true,
      }).catch(() => undefined);
      throw error;
    } finally {
      if (startInFlight?.attempt === attempt) startInFlight = null;
    }
  }

  async function executeOpenCodeSessionStart(request = {}) {
    if (bridgeShutdownRequested || shutdownInProgress > 0) {
      throw new Error("OpenCode session host is shutting down.");
    }
    const payload = requestBody(request);
    const startGeneration = shutdownGeneration;
    const assertStartStillAuthorized = () => {
      if (
        startGeneration !== shutdownGeneration
        || shutdownInProgress > 0
      ) {
        throw new Error("OpenCode session start was cancelled by host shutdown.");
      }
    };
    let checked;
    try {
      checked = await runPreflight(payload, "start");
      assertStartStillAuthorized();
    } catch (error) {
      if (currentAttempt && isExplicitRevocation(error)) {
        await disposeAttempt(currentAttempt, {
          reason: "preflight-revoked",
          terminalState: SESSION_STATE.FAILED,
          terminate: true,
        }).catch(() => undefined);
      } else if (!currentAttempt) {
        state = SESSION_STATE.FAILED;
      }
      throw error;
    }

    await cleanupBarrier;
    assertStartStillAuthorized();
    if (cleanupFailure) {
      throw new Error(
        "Previous OpenCode session cleanup failed; restart the bridge before starting another session.",
      );
    }

    if (currentAttempt) {
      if (checked.workspace !== currentAttempt.workspace) {
        throw new Error("An OpenCode session is already active for a different workspace.");
      }
      if (state === SESSION_STATE.RUNNING && currentAttempt.publicResult) {
        return { ...currentAttempt.publicResult };
      }
      if (state === SESSION_STATE.STARTING && startInFlight?.attempt === currentAttempt) {
        return startInFlight.promise;
      }
      throw new Error("The active OpenCode session is unavailable.");
    }

    const attempt = {
      abortController: null,
      cleanupPromise: null,
      client: null,
      cursor: 0,
      detachProcessExit: null,
      disposed: false,
      droppedBefore: 0,
      deltaStreams: new Map(),
      eventBytes: 0,
      events: [],
      lifecycle: null,
      model: checked.model,
      permissionRequests: new Map(),
      pendingStartEvents: [],
      preflightResult: checked.raw,
      process: null,
      publicResult: null,
      publicWorkspace: checked.publicWorkspace,
      pumpPromise: null,
      sessionId: "",
      workspace: checked.workspace,
    };
    currentAttempt = attempt;
    state = SESSION_STATE.STARTING;
    const promise = createRunningSession(attempt);
    startInFlight = { attempt, promise };
    return promise;
  }

  async function executeOpenCodeSessionPrompt(request = {}) {
    const payload = requestBody(request);
    const attempt = requireOwnedAttempt(payload);
    if (typeof payload.text !== "string") {
      throw new Error("OpenCode prompt text must be a string.");
    }
    const text = payload.text.trim();
    if (!text) throw new Error("OpenCode prompt requires non-empty text.");

    await revalidateOwnedAttempt(attempt, "prompt");
    await attempt.client.prompt({
      sessionID: attempt.sessionId,
      text,
    });
    return {};
  }

  async function executeOpenCodeSessionPermission(request = {}) {
    const payload = requestBody(request);
    const attempt = requireOwnedAttempt(payload);
    const requestId = typeof payload.requestId === "string"
      ? payload.requestId.trim()
      : "";
    if (!requestId) {
      throw new Error("OpenCode permission reply requires a requestId.");
    }
    if (payload.reply !== "once" && payload.reply !== "reject") {
      throw new Error("OpenCode permission reply must be once or reject.");
    }

    await revalidateOwnedAttempt(attempt, "permission");
    const mapped = attempt.permissionRequests.get(requestId);
    if (!mapped) {
      throw new Error("OpenCode requestId is not an active session permission request.");
    }
    attempt.permissionRequests.delete(requestId);
    try {
      await attempt.client.replyPermission({
        sessionID: attempt.sessionId,
        requestID: mapped.requestID,
        reply: payload.reply,
      });
    } catch (error) {
      if (
        !attempt.disposed
        && currentAttempt === attempt
        && !attempt.permissionRequests.has(requestId)
      ) {
        attempt.permissionRequests.set(requestId, mapped);
      }
      throw error;
    }
    return {};
  }

  async function executeOpenCodeSessionEvents(request = {}) {
    const payload = requestBody(request);
    const attempt = requireOwnedAttempt(payload);
    const after = Object.hasOwn(payload, "after") ? payload.after : 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("OpenCode event cursor after must be a non-negative safe integer.");
    }

    await revalidateOwnedAttempt(attempt, "events");
    return {
      events: attempt.events
        .filter((entry) => entry.cursor > after)
        .map((entry) => entry.event),
      nextCursor: attempt.cursor,
      droppedBefore: attempt.droppedBefore,
    };
  }

  async function executeOpenCodeSessionStop(request = {}) {
    const payload = requestBody(request);
    const attempt = requireOwnedAttempt(payload);
    await revalidateOwnedAttempt(attempt, "stop");
    await disposeAttempt(attempt, {
      reason: "explicit-stop",
      terminalState: SESSION_STATE.STOPPED,
      terminate: true,
    });
    return { stopped: true };
  }

  async function shutdownOpenCodeSession({ permanent = true } = {}) {
    if (permanent) bridgeShutdownRequested = true;
    shutdownGeneration += 1;
    shutdownInProgress += 1;
    try {
      const attempt = currentAttempt;
      const pendingStart = startInFlight?.attempt === attempt
        ? startInFlight.promise
        : null;
      if (!attempt) {
        await cleanupBarrier;
        state = SESSION_STATE.STOPPED;
        if (cleanupFailure) {
          throw new Error("OpenCode session cleanup failed during bridge shutdown.");
        }
        return;
      }
      await disposeAttempt(attempt, {
        reason: "bridge-shutdown",
        terminalState: SESSION_STATE.STOPPED,
        terminate: true,
      });
      if (pendingStart) await pendingStart.catch(() => undefined);
    } finally {
      shutdownInProgress -= 1;
    }
  }

  return {
    executeOpenCodeSessionEvents,
    executeOpenCodeSessionPermission,
    executeOpenCodeSessionPrompt,
    executeOpenCodeSessionStart,
    executeOpenCodeSessionStop,
    shutdownOpenCodeSession,
  };
}
