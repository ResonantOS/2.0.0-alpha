// Extension-side adapter that connects the live OpenCode session element to the
// bridge routes. subscribe() streams the bridge's SSE proxy of `opencode serve`'s
// /event bus (via fetch + a ReadableStream reader, so the auth header travels in
// a header rather than a URL secret); sendPrompt/replyPermission POST to the
// session routes. The SSE framing parser is pure and unit-tested.

// Incrementally parse a text/event-stream. Returns a feed(chunk) function that
// invokes onEvent(parsedJSON) per complete `data:` event, buffering partial
// frames across chunk boundaries and ignoring non-JSON keepalives.
export function createSSEParser(onEvent) {
  let buffer = "";
  return function feed(chunk) {
    buffer += chunk;
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
        /* keepalive / non-JSON frame — ignore */
      }
    }
  };
}

// deps:
//   startSession()               -> { sessionId, eventUrl }
//   openEventStream(eventUrl)    -> a Response whose body is a ReadableStream (fetch with auth header)
//   postJson(path, body)         -> POST helper to the bridge
export function createOpenCodeBridgeSource({ startSession, openEventStream, postJson } = {}) {
  let sessionId = "";

  return {
    async start() {
      const info = await startSession();
      sessionId = info?.sessionId ?? "";
      return info;
    },

    subscribe(onEvent) {
      let cancelled = false;
      let reader = null;
      (async () => {
        try {
          const info = await startSession();
          sessionId = info?.sessionId ?? sessionId;
          const res = await openEventStream(info?.eventUrl ?? "");
          if (!res?.body?.getReader) return;
          reader = res.body.getReader();
          const decoder = new TextDecoder();
          const feed = createSSEParser(onEvent);
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            feed(decoder.decode(value, { stream: true }));
          }
        } catch {
          /* stream ended / connection dropped */
        }
      })();
      return () => {
        cancelled = true;
        try { reader?.cancel?.(); } catch { /* noop */ }
      };
    },

    async sendPrompt(text) {
      if (!sessionId) return;
      await postJson("/opencode/session/prompt", { sessionId, text });
    },

    async replyPermission(permissionId, decision) {
      if (!sessionId) return;
      await postJson("/opencode/session/permission", { sessionId, permissionId, decision });
    }
  };
}
