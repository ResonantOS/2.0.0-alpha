const EVENT_BUFFER_LIMIT = 500;
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
    attempt.permissionRequests.clear();
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

  function recordEvent(attempt, event) {
    if (
      attempt.disposed
      || currentAttempt !== attempt
      || state !== SESSION_STATE.RUNNING
      || event?.data?.sessionID !== attempt.sessionId
    ) {
      return;
    }

    attempt.cursor += 1;
    const entry = { cursor: attempt.cursor, event };
    attempt.events.push(entry);

    const requestID = permissionRequestId(event);
    if (requestID) {
      attempt.permissionRequests.set(requestID, {
        cursor: entry.cursor,
        requestID,
      });
    }

    if (attempt.events.length <= EVENT_BUFFER_LIMIT) return;
    const dropped = attempt.events.shift();
    attempt.droppedBefore = dropped.cursor;
    const droppedRequestID = permissionRequestId(dropped.event);
    if (
      droppedRequestID
      && attempt.permissionRequests.get(droppedRequestID)?.cursor === dropped.cursor
    ) {
      attempt.permissionRequests.delete(droppedRequestID);
    }
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

      state = SESSION_STATE.RUNNING;
      attempt.publicResult = Object.freeze({
        sessionId,
        workspace: attempt.publicWorkspace,
      });
      attempt.pumpPromise = consumeEvents(attempt, source);
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
    const payload = requestBody(request);
    let checked;
    try {
      checked = await runPreflight(payload, "start");
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
      events: [],
      lifecycle: null,
      model: checked.model,
      permissionRequests: new Map(),
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
    const permissionId = typeof payload.permissionId === "string"
      ? payload.permissionId.trim()
      : "";
    if (!permissionId) {
      throw new Error("OpenCode permission reply requires a permissionId.");
    }
    if (payload.reply !== "once" && payload.reply !== "reject") {
      throw new Error("OpenCode permission reply must be once or reject.");
    }

    await revalidateOwnedAttempt(attempt, "permission");
    const mapped = attempt.permissionRequests.get(permissionId);
    if (!mapped) {
      throw new Error("OpenCode permissionId is not an active session permission request.");
    }
    attempt.permissionRequests.delete(permissionId);
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
        && !attempt.permissionRequests.has(permissionId)
      ) {
        attempt.permissionRequests.set(permissionId, mapped);
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
      entries: attempt.events
        .filter((entry) => entry.cursor > after)
        .map((entry) => ({ cursor: entry.cursor, event: entry.event })),
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

  async function shutdownOpenCodeSession() {
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
