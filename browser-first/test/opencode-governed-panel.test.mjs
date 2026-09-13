import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createBridgeClient } from "../resonantos-side-panel-extension/src/lib/bridge-client.js";
import { createOpenCodeSession } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode-session.js";
import { renderOpenCodeWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode.js";

function setupDom() {
  const dom = new JSDOM("<!doctype html><main id=\"root\"></main>", { url: "https://resonantos.local/" });
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  return {
    window: dom.window,
    container: dom.window.document.querySelector("#root"),
    cleanup: () => {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Event;
    }
  };
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function controllableSse() {
  const encoder = new TextEncoder();
  const queue = [];
  let notify = () => {};
  let cancelled = false;
  return {
    push(text) {
      queue.push(encoder.encode(text));
      notify();
    },
    response: {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name).toLowerCase() === "content-type" ? "text/event-stream" : null;
        }
      },
      body: {
        getReader() {
          return {
            async read() {
              while (!cancelled) {
                if (queue.length) return { value: queue.shift(), done: false };
                await new Promise((resolve) => {
                  notify = resolve;
                });
              }
              return { value: undefined, done: true };
            },
            cancel() {
              cancelled = true;
              notify();
            }
          };
        }
      }
    }
  };
}

function hangingJson(payload) {
  return {
    ok: true,
    json: async () => payload
  };
}

function envelope(sessionId, source, event) {
  return { version: 1, sessionId, source, event };
}

function frame(sessionId, source, event) {
  return `data: ${JSON.stringify(envelope(sessionId, source, event))}\n\n`;
}

function jsonBridge(handlers) {
  return async (route, options = {}) => {
    if (options.responseType === "sse" || String(route).startsWith("/opencode/session/events")) {
      return handlers.events(route, options);
    }
    if (route === "/opencode/status") {
      return {
        installed: true,
        proxyExecutionEnabled: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.4-mini",
        detail: "Ready",
        ...(handlers.status ?? {})
      };
    }
    if (typeof handlers[route] === "function") return handlers[route](options);
    if (route === "/opencode/session/start") return { ok: true, sessionId: handlers.sessionId ?? "s1" };
    if (route === "/opencode/sessions/list") return { ok: true, sessions: handlers.sessions ?? [{ id: handlers.sessionId ?? "s1", title: "A", created: Date.now(), updated: Date.now() }] };
    if (route === "/opencode/session/messages") return { ok: true, messages: handlers.messages ?? [] };
    if (route === "/opencode/agents/list") return { ok: true, agents: [] };
    if (route === "/opencode/session/diff") return { ok: true, diff: [] };
    return { ok: true };
  };
}

test("events request goes to config.bridgeUrl", async () => {
  const { container, cleanup } = setupDom();
  const bridgeUrl = "http://127.0.0.1:47773";
  let destination = "";
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/opencode/session/events") {
      destination = parsed.origin;
      return controllableSse().response;
    }
    let payload = { ok: true };
    if (parsed.pathname === "/opencode/status") {
      payload = { ok: true, installed: true, proxyExecutionEnabled: true, command: "opencode", detail: "Ready" };
    } else if (parsed.pathname === "/opencode/session/start") {
      payload = { ok: true, sessionId: "s1" };
    } else if (parsed.pathname === "/opencode/sessions/list") {
      payload = { ok: true, sessions: [] };
    } else if (parsed.pathname === "/opencode/agents/list") {
      payload = { ok: true, agents: [] };
    }
    return hangingJson(payload);
  };
  try {
    renderOpenCodeWorkspace({
      container,
      bridgeRequest: createBridgeClient({
        bridgeUrl,
        bridgeToken: randomBytes(12).toString("hex"),
        bridgeCapabilityTokens: { "addon-runtime-read": randomBytes(12).toString("hex"), "addon-runtime-control": randomBytes(12).toString("hex") },
        fetchImpl
      })
    });
    await wait();
    container.querySelector(".opencode-start-session").click();
    for (let i = 0; i < 40 && !destination; i += 1) await wait(5);
    assert.equal(destination, bridgeUrl);
  } finally {
    cleanup();
  }
});

test("extension uses bridge origin and read capability for events", async () => {
  const { container, cleanup } = setupDom();
  const bridgeUrl = "http://127.0.0.1:47773";
  const bridgeToken = randomBytes(16).toString("hex");
  const readToken = randomBytes(16).toString("hex");
  let recorded;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/opencode/session/events") {
      recorded = { url: String(url), headers: init.headers ?? {} };
      return controllableSse().response;
    }
    let payload = { ok: true };
    if (parsed.pathname === "/opencode/status") {
      payload = { ok: true, installed: true, proxyExecutionEnabled: true, command: "opencode", detail: "Ready" };
    } else if (parsed.pathname === "/opencode/session/start") {
      payload = { ok: true, sessionId: "s1" };
    } else if (parsed.pathname === "/opencode/sessions/list") {
      payload = { ok: true, sessions: [] };
    } else if (parsed.pathname === "/opencode/agents/list") {
      payload = { ok: true, agents: [] };
    }
    return hangingJson(payload);
  };
  try {
    renderOpenCodeWorkspace({
      container,
      bridgeRequest: createBridgeClient({
        bridgeUrl,
        bridgeToken,
        bridgeCapabilityTokens: {
          "addon-runtime-read": readToken,
          "addon-runtime-control": randomBytes(16).toString("hex")
        },
        fetchImpl
      })
    });
    await wait();
    container.querySelector(".opencode-start-session").click();
    for (let i = 0; i < 40 && !recorded; i += 1) await wait(5);
    assert.deepEqual(
      [
        recorded?.url,
        recorded?.headers["X-ResonantOS-Bridge-Token"] === bridgeToken,
        recorded?.headers["X-ResonantOS-Bridge-Capability-Token"] === readToken,
        recorded?.headers.Authorization == null
      ],
      [`${bridgeUrl}/opencode/session/events?sessionId=s1`, true, true, true]
    );
  } finally {
    cleanup();
  }
});

test("panel shows own events with source badges", async () => {
  const { container, cleanup } = setupDom();
  let emit = () => {};
  createOpenCodeSession({
    document: globalThis.document,
    container,
    sessionId: "A",
    subscribe: (handler) => {
      emit = handler;
      return () => {};
    }
  });
  emit(envelope("A", "governed", { type: "text.delta", properties: { messageID: "m1", text: "hi" } }));
  emit(envelope("A", "external", { type: "text.delta", properties: { messageID: "m2", text: "bye" } }));
  emit(envelope("B", "governed", { type: "text.delta", properties: { messageID: "m3", text: "nope" } }));
  assert.deepEqual(
    [...container.querySelectorAll(".oc-badge")].map((badge) => [badge.dataset.source, badge.textContent]),
    [["governed", "Governed"], ["external", "External"]]
  );
  cleanup();
});

test("foreign and unscoped events cannot refresh diff", async () => {
  const { container, cleanup } = setupDom();
  const stream = controllableSse();
  let diffCount = 0;
  const bridgeRequest = jsonBridge({
    sessionId: "s1",
    events: () => stream.response,
    "/opencode/session/diff": () => {
      diffCount += 1;
      return { ok: true, diff: [] };
    }
  });
  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await wait();
    container.querySelector(".opencode-start-session").click();
    for (let i = 0; i < 40 && !container.querySelector(".oc-session"); i += 1) await wait(5);
    await wait(20);
    const baseline = diffCount;
    stream.push(frame("s2", "governed", { type: "file.edited", properties: { path: "a.txt", added: 1, removed: 0 } }));
    stream.push(`data: ${JSON.stringify({ event: { type: "file.edited", properties: { path: "a.txt" } } })}\n\n`);
    await wait(1100);
    assert.equal(diffCount - baseline, 0);
  } finally {
    cleanup();
  }
});

test("resume preserves host history attribution", async () => {
  const { container, cleanup } = setupDom();
  const stream = controllableSse();
  const history = ["governed", "external"].flatMap((source, index) => [
    { info: { id: `text-${index}`, role: "assistant" }, parts: [{ type: "text", text: `seeded ${source}` }], source },
    { info: { id: `tool-${index}`, role: "assistant" }, parts: [{ type: "tool", callID: `t-${index}`, tool: "edit", state: { status: "completed", output: "ok" } }], source },
    { info: { id: `file-${index}`, role: "assistant" }, parts: [{ type: "file", path: `${source}.ts`, added: 1, removed: 0 }], source }
  ]);
  const bridgeRequest = jsonBridge({
    sessionId: "s1",
    events: () => stream.response,
    messages: history
  });
  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await wait();
    container.querySelector(".opencode-start-session").click();
    for (let i = 0; i < 40 && !container.querySelector(".ocb-session"); i += 1) await wait(5);
    container.querySelector(".ocb-session[data-session-id='s1']").click();
    for (let i = 0; i < 40 && !container.querySelector(".oc-msg .oc-badge"); i += 1) await wait(5);
    assert.deepEqual(
      [".oc-msg", ".oc-tool", ".oc-file"].map((selector) =>
        [...container.querySelectorAll(`${selector} .oc-badge`)].map((badge) => badge.dataset.source).sort()),
      ["text", "tool", "file"].map((type) =>
        history.filter((message) => message.parts[0].type === type).map((message) => message.source).sort())
    );
  } finally {
    container.replaceChildren();
    cleanup();
  }
});

test("mixed-source entries never merge into governed output (covers file/diff paths)", async () => {
  const { container, cleanup } = setupDom();
  let emit = () => {};
  createOpenCodeSession({
    document: globalThis.document,
    container,
    sessionId: "s1",
    subscribe: (handler) => {
      emit = handler;
      return () => {};
    }
  });
  emit(envelope("s1", "governed", { type: "file.edited", properties: { path: "a.txt", added: 1, removed: 0 } }));
  emit(envelope("s1", "external", { type: "file.edited", properties: { path: "a.txt", added: 2, removed: 0 } }));
  emit(envelope("s1", "governed", { type: "session.diff", properties: { files: [{ path: "a.txt", added: 3, removed: 0, source: "governed" }, { path: "a.txt", added: 5, removed: 1, source: "external" }] } }));
  assert.deepEqual(
    [
      [...container.querySelectorAll(".oc-file")].map((row) => [row.dataset.path, row.querySelector(".oc-badge").dataset.source, row.querySelector(".oc-file-stat").textContent]).sort(),
      container.querySelector(".oc-diff-title .oc-badge")?.dataset.source
    ],
    [[["a.txt", "external", "+5−1"], ["a.txt", "governed", "+3−0"]], "external"]
  );
  cleanup();
});

test("typed close disables panel actions", async () => {
  const { container, cleanup } = setupDom();
  let emit = () => {};
  const session = createOpenCodeSession({
    document: globalThis.document,
    container,
    sessionId: "s1",
    subscribe: (handler) => {
      emit = handler;
      return () => {};
    }
  });
  emit(envelope("s1", "governed", { type: "permission.asked", properties: { id: "p1", tool: "shell", title: "Run", detail: "ls" } }));
  session.setTransportError({ code: "OPENCODE_STREAM_DISCONNECTED", error: "OpenCode boundary request failed." });
  assert.equal(
    [...container.querySelectorAll(".oc-composer textarea, .oc-send, .oc-approve-actions button")].every((node) => node.disabled),
    true
  );
  cleanup();
});

test("destroyed panel ignores late events", async () => {
  const { container, cleanup } = setupDom();
  let emit = () => {};
  const session = createOpenCodeSession({
    document: globalThis.document,
    container,
    sessionId: "s1",
    subscribe: (handler) => {
      emit = handler;
      return () => {};
    }
  });
  session.destroy();
  const snapshot = container.innerHTML;
  emit(envelope("s1", "governed", { type: "text.delta", properties: { messageID: "m1", text: "late" } }));
  assert.equal(container.innerHTML, snapshot);
  cleanup();
});

test("own-session file.edited still schedules diff refresh", async () => {
  const { container, cleanup } = setupDom();
  const stream = controllableSse();
  let diffCount = 0;
  const bridgeRequest = jsonBridge({
    sessionId: "s1",
    events: () => stream.response,
    "/opencode/session/diff": () => {
      diffCount += 1;
      return { ok: true, diff: [] };
    }
  });
  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await wait();
    container.querySelector(".opencode-start-session").click();
    for (let i = 0; i < 40 && !container.querySelector(".oc-session"); i += 1) await wait(5);
    await wait(20);
    const baseline = diffCount;
    stream.push(frame("s1", "governed", { type: "file.edited", properties: { path: "a.txt", added: 1, removed: 0 } }));
    await wait(1100);
    assert.equal(diffCount - baseline, 1);
  } finally {
    cleanup();
  }
});
