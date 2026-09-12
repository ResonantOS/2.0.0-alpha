// Extension-side adapter that connects the live OpenCode session element to the
// bridge routes. subscribe() streams the bridge's SSE proxy of `opencode serve`'s
// /event bus (via fetch + a ReadableStream reader); sendPrompt/replyPermission
// POST to the session routes. The SSE framing parser is pure and unit-tested.

const PUBLIC_OPENCODE_ERROR = "OpenCode boundary request failed.";
const HTTP_STATUS_CODES = Object.freeze({
  400: "OPENCODE_INVALID_REQUEST",
  401: "OPENCODE_BRIDGE_UNAUTHORIZED",
  403: "OPENCODE_CAPABILITY_REQUIRED",
  404: "OPENCODE_SESSION_UNKNOWN",
  429: "OPENCODE_LIMIT",
  502: "OPENCODE_UPSTREAM_FAILED",
  503: "OPENCODE_UNAVAILABLE",
  504: "OPENCODE_TIMEOUT"
});

function typedError(code, error = PUBLIC_OPENCODE_ERROR) {
  return { code, error };
}

function isAbortError(error) {
  return error && typeof error === "object" && error.name === "AbortError";
}

function codeFromPayload(payload, status) {
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (code.startsWith("OPENCODE_")) return code;
  return HTTP_STATUS_CODES[status] || "OPENCODE_INTERNAL";
}

function codeFromThrown(error) {
  if (!error || typeof error !== "object") return "OPENCODE_STREAM_DISCONNECTED";
  if (typeof error.code === "string" && error.code.startsWith("OPENCODE_")) return error.code;
  const payloadCode = error.bridgePayload?.code;
  if (typeof payloadCode === "string" && payloadCode.startsWith("OPENCODE_")) return payloadCode;
  if (typeof error.bridgeStatus === "number") return codeFromPayload(error.bridgePayload, error.bridgeStatus);
  return "OPENCODE_STREAM_DISCONNECTED";
}

function contentTypeOf(response) {
  const headers = response?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get("content-type") ?? "");
  return String(headers["content-type"] ?? headers["Content-Type"] ?? "");
}

function isEventStream(response) {
  return contentTypeOf(response).toLowerCase().includes("text/event-stream");
}

function isValidEnvelope(envelope, sessionId) {
  if (!envelope || typeof envelope !== "object") return false;
  if (envelope.version !== 1) return false;
  if (typeof envelope.sessionId !== "string" || !envelope.sessionId) return false;
  if (envelope.sessionId !== sessionId) return false;
  if (envelope.source !== "governed" && envelope.source !== "external") return false;
  if (!envelope.event || typeof envelope.event !== "object") return false;
  return true;
}

function eventType(envelope) {
  return String(envelope?.event?.type ?? envelope?.event?.kind ?? "");
}

function closedProperties(envelope) {
  const properties = envelope?.event?.properties ?? envelope?.event ?? {};
  return {
    code: typeof properties.code === "string" && properties.code.startsWith("OPENCODE_")
      ? properties.code
      : "OPENCODE_STREAM_DISCONNECTED",
    error: typeof properties.error === "string" && properties.error
      ? properties.error
      : PUBLIC_OPENCODE_ERROR
  };
}

// Incrementally parse a text/event-stream. Returns a feed(chunk) function that
// invokes onEvent(parsedJSON) per complete `data:` event, buffering partial
// frames across chunk boundaries. Comment/keepalive frames are ignored;
// malformed JSON is a typed protocol error.
export function createSSEParser(onEvent, onError) {
  let buffer = "";
  let failed = false;
  return function feed(chunk) {
    if (failed) return;
    buffer += String(chunk ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        failed = true;
        onError?.(typedError("OPENCODE_PROTOCOL_ERROR"));
        return;
      }
    }
  };
}

// deps:
//   startSession()                    -> { sessionId }
//   openEventStream(sessionId,{signal}) -> Promise<Response>
//   postJson(path, body)              -> POST helper to the bridge
//   onError({code,error})             -> typed transport failure
export function createOpenCodeBridgeSource({ startSession, openEventStream, postJson, onError } = {}) {
  let sessionId = "";
  let startPromise = null;

  function report(code, error = PUBLIC_OPENCODE_ERROR) {
    onError?.(typedError(code, error));
  }

  async function loadSession() {
    if (sessionId) return sessionId;
    if (typeof startSession !== "function") {
      report("OPENCODE_SESSION_UNKNOWN");
      return "";
    }
    if (!startPromise) {
      startPromise = Promise.resolve()
        .then(() => startSession())
        .then((info) => {
          const id = typeof info?.sessionId === "string" ? info.sessionId : "";
          if (!id) {
            report("OPENCODE_SESSION_UNKNOWN");
            return "";
          }
          sessionId = id;
          return id;
        })
        .catch((error) => {
          if (!isAbortError(error)) report(codeFromThrown(error));
          return "";
        });
    }
    return startPromise;
  }

  async function ensureSessionId() {
    const id = await loadSession();
    if (!id) report("OPENCODE_SESSION_UNKNOWN");
    return id;
  }

  return {
    async start() {
      const info = typeof startSession === "function" ? await startSession() : null;
      const id = typeof info?.sessionId === "string" ? info.sessionId : "";
      if (!id) {
        report("OPENCODE_SESSION_UNKNOWN");
        return info;
      }
      sessionId = id;
      return info;
    },

    subscribe(onEvent) {
      let cancelled = false;
      let terminal = false;
      let reader = null;
      const ac = new AbortController();

      const fail = (code, error = PUBLIC_OPENCODE_ERROR) => {
        if (cancelled || terminal) return;
        terminal = true;
        report(code, error);
        try { ac.abort(); } catch { /* noop */ }
      };

      (async () => {
        try {
          const id = await loadSession();
          if (cancelled) return;
          if (!id) {
            fail("OPENCODE_SESSION_UNKNOWN");
            return;
          }
          if (typeof openEventStream !== "function") {
            fail("OPENCODE_PROTOCOL_ERROR");
            return;
          }
          let res;
          try {
            res = await openEventStream(id, { signal: ac.signal });
          } catch (error) {
            if (cancelled || isAbortError(error)) return;
            fail(codeFromThrown(error));
            return;
          }
          if (cancelled) return;
          if (!res || res.ok === false) {
            let payload = {};
            try {
              payload = await (res?.json?.() ?? Promise.resolve({}));
            } catch {
              payload = {};
            }
            fail(codeFromPayload(payload, res?.status));
            return;
          }
          if (!isEventStream(res) || !res.body?.getReader) {
            fail("OPENCODE_PROTOCOL_ERROR");
            return;
          }
          reader = res.body.getReader();
          const decoder = new TextDecoder();
          const feed = createSSEParser((envelope) => {
            if (cancelled || terminal) return;
            if (!isValidEnvelope(envelope, id)) return;
            if (eventType(envelope) === "bridge.closed") {
              const closed = closedProperties(envelope);
              fail(closed.code, closed.error);
              return;
            }
            onEvent?.(envelope);
          }, (err) => {
            fail(err?.code ?? "OPENCODE_PROTOCOL_ERROR", err?.error);
          });
          while (!cancelled && !terminal) {
            const { value, done } = await reader.read();
            if (done) {
              if (!cancelled && !terminal) fail("OPENCODE_STREAM_DISCONNECTED");
              break;
            }
            feed(decoder.decode(value, { stream: true }));
          }
        } catch (error) {
          if (cancelled || terminal || isAbortError(error)) return;
          fail(codeFromThrown(error));
        }
      })();

      return () => {
        cancelled = true;
        try { ac.abort(); } catch { /* noop */ }
        try { reader?.cancel?.(); } catch { /* noop */ }
      };
    },

    async sendPrompt(text, { model, agent } = {}) {
      const id = await ensureSessionId();
      if (!id) return;
      await postJson("/opencode/session/prompt", {
        sessionId: id,
        text,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {})
      });
    },

    async replyPermission(permissionId, decision) {
      const id = await ensureSessionId();
      if (!id) return;
      await postJson("/opencode/session/permission", { sessionId: id, permissionId, decision });
    },

    async abort() {
      const id = await ensureSessionId();
      if (!id) return;
      await postJson("/opencode/session/abort", { sessionId: id });
    },

    async diff() {
      const id = await ensureSessionId();
      if (!id) return [];
      const payload = await postJson("/opencode/session/diff", { sessionId: id });
      return Array.isArray(payload?.diff) ? payload.diff : (Array.isArray(payload) ? payload : []);
    }
  };
}
