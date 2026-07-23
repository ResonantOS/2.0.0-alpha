// Extension-side adapter for the authenticated, session-bound OpenCode bridge
// routes. One source owns one bridge session and one bounded polling loop.

function defaultSleep({ signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, 250);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function requiredFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`OpenCode bridge source requires ${name}.`);
  }
  return value;
}

function sessionIdFrom(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeCallback(callback, value) {
  if (typeof callback !== "function") return;
  try {
    callback(value);
  } catch {
    // UI observers cannot take down the governed polling boundary.
  }
}

function validatePollResponse(response, requestedAfter, sessionId) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("OpenCode event cursor response must be an object.");
  }
  const { droppedBefore, events, nextCursor } = response;
  if (
    !Number.isSafeInteger(nextCursor)
    || nextCursor < requestedAfter
    || !Number.isSafeInteger(droppedBefore)
    || droppedBefore < 0
    || droppedBefore > nextCursor
    || !Array.isArray(events)
  ) {
    throw new Error("OpenCode event cursor response is malformed.");
  }

  const attributableEvents = [];
  for (const event of events) {
    if (
      !event
      || typeof event !== "object"
      || Array.isArray(event)
    ) {
      throw new Error("OpenCode event cursor events are malformed.");
    }
    if (sessionIdFrom(event?.data?.sessionID) !== sessionId) {
      throw new Error("OpenCode event does not belong to the active session.");
    }
    attributableEvents.push(event);
  }
  return { droppedBefore, events: attributableEvents, nextCursor };
}

export function createOpenCodeBridgeSource({
  onCursorGap,
  onPollingError,
  postJson,
  sleep = defaultSleep,
  startSession,
} = {}) {
  const startBridgeSession = requiredFunction("startSession", startSession);
  const postBridgeJson = requiredFunction("postJson", postJson);
  const waitBetweenPolls = requiredFunction("sleep", sleep);

  const subscribers = new Set();
  let cursor = 0;
  let session = null;
  let startPromise = null;
  let pollRun = null;
  let stopped = false;

  function ensureSession() {
    if (stopped) {
      return Promise.reject(new Error("OpenCode bridge source has been stopped."));
    }
    if (session) return Promise.resolve({ ...session });
    if (!startPromise) {
      startPromise = Promise.resolve(startBridgeSession())
        .then((info) => {
          const sessionId = sessionIdFrom(info?.sessionId);
          if (!sessionId) {
            throw new Error("OpenCode bridge session start returned no sessionId.");
          }
          session = {
            sessionId,
            ...(typeof info?.workspace === "string"
              ? { workspace: info.workspace }
              : {}),
          };
          return { ...session };
        })
        .catch((error) => {
          startPromise = null;
          throw error;
        });
    }
    return startPromise;
  }

  function publish(event) {
    for (const subscriber of subscribers) safeCallback(subscriber, event);
  }

  async function runPolling(controller) {
    try {
      const ownedSession = await ensureSession();
      while (!controller.signal.aborted && subscribers.size > 0) {
        const requestedAfter = cursor;
        const response = await postBridgeJson("/opencode/session/events", {
          sessionId: ownedSession.sessionId,
          after: requestedAfter,
        });
        if (controller.signal.aborted || subscribers.size === 0) return;

        const parsed = validatePollResponse(
          response,
          requestedAfter,
          ownedSession.sessionId,
        );
        if (parsed.droppedBefore > requestedAfter) {
          safeCallback(onCursorGap, {
            droppedBefore: parsed.droppedBefore,
            requestedAfter,
            sessionId: ownedSession.sessionId,
          });
        }
        for (const event of parsed.events) publish(event);
        cursor = parsed.nextCursor;

        await waitBetweenPolls({ signal: controller.signal });
      }
    } catch (error) {
      if (controller.signal.aborted) return true;
      controller.abort();
      safeCallback(
        onPollingError,
        error instanceof Error ? error : new Error(String(error)),
      );
      return false;
    }
    return true;
  }

  function beginPolling() {
    if (pollRun || stopped || subscribers.size === 0) return;
    const controller = new AbortController();
    const promise = runPolling(controller);
    const run = { controller, promise };
    pollRun = run;
    void promise.then((restartAllowed) => {
      if (pollRun !== run) return;
      pollRun = null;
      if (restartAllowed && !stopped && subscribers.size > 0) {
        beginPolling();
      }
    });
  }

  function cancelPolling() {
    pollRun?.controller.abort();
  }

  return {
    start() {
      return ensureSession();
    },

    subscribe(onEvent) {
      if (typeof onEvent !== "function") {
        throw new Error("OpenCode bridge source subscribe requires an event callback.");
      }
      subscribers.add(onEvent);
      beginPolling();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscribers.delete(onEvent);
        if (subscribers.size === 0) cancelPolling();
      };
    },

    async sendPrompt(text) {
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("OpenCode prompt requires non-empty text.");
      }
      const ownedSession = await ensureSession();
      return postBridgeJson("/opencode/session/prompt", {
        sessionId: ownedSession.sessionId,
        text,
      });
    },

    async replyPermission(requestId, reply) {
      if (reply !== "once" && reply !== "reject") {
        throw new Error("OpenCode permission reply must be once or reject.");
      }
      const id = sessionIdFrom(requestId);
      if (!id) {
        throw new Error("OpenCode permission reply requires a requestId.");
      }
      const ownedSession = await ensureSession();
      return postBridgeJson("/opencode/session/permission", {
        sessionId: ownedSession.sessionId,
        requestId: id,
        reply,
      });
    },

    async stop() {
      if (stopped) return { stopped: true };
      cancelPolling();
      const ownedSession = session ?? (startPromise ? await startPromise : null);
      stopped = true;
      subscribers.clear();
      if (!ownedSession) return { stopped: false };
      return postBridgeJson("/opencode/session/stop", {
        sessionId: ownedSession.sessionId,
      });
    },
  };
}
