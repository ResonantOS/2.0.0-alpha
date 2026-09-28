import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderOpenCodeWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode.js";

function hangingSse(frames = []) {
  const encoded = frames.map((frame) => (
    typeof frame === "string" ? new TextEncoder().encode(frame) : frame
  ));
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "text/event-stream" : null;
      }
    },
    body: {
      getReader() {
        let index = 0;
        let release;
        const blocker = new Promise((resolve) => {
          release = resolve;
        });
        return {
          async read() {
            if (index < encoded.length) return { value: encoded[index++], done: false };
            await blocker;
            return { value: undefined, done: true };
          },
          cancel() {
            release?.();
          }
        };
      }
    }
  };
}

function envelopeFrame(sessionId, event, source = "governed") {
  return `data: ${JSON.stringify({ version: 1, sessionId, source, event })}\n\n`;
}

function isEventsRoute(route, options = {}) {
  return options.responseType === "sse" || String(route ?? "").startsWith("/opencode/session/events");
}

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
      if (previousFetch === undefined) {
        delete globalThis.fetch;
      } else {
        globalThis.fetch = previousFetch;
      }
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Event;
    }
  };
}

test("opencode workspace renders runtime status and creates governed delegation packets", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/opencode/status") {
      return {
        installed: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.4-mini",
        detail: "OpenCode runtime was detected.",
        delegationPackets: 1
      };
    }
    if (route === "/addons/delegate") {
      return {
        id: "opencode-1",
        path: "BrowserFirst/Delegations/opencode/opencode-1.md",
        status: "queued"
      };
    }
    if (route === "/opencode/delegation/start") {
      return {
        id: "opencode-1",
        path: options.body.path,
        resultArtifactPath: "BrowserFirst/DelegationArtifacts/opencode/opencode-1-result.md",
        status: "completed"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /Scoped coding work/);
    assert.match(container.textContent, /OpenCode runtime was detected/);
    assert.match(container.textContent, /\/usr\/local\/bin\/opencode/);
    assert.match(container.textContent, /model openai\/gpt-5\.4-mini/);
    assert.match(container.textContent, /Provider secrets, wallet actions, and trusted Living Archive writes/);

    const mission = container.querySelector("textarea");
    mission.value = "Use OpenCode to inspect the browser-first workspace tests and return verification evidence.";
    container.querySelector(".opencode-task-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/addons/delegate" &&
      options.body.target === "opencode" &&
      /browser-first workspace tests/.test(options.body.mission)
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/delegation/start" &&
      options.body.path === "BrowserFirst/Delegations/opencode/opencode-1.md"
    ));
    assert.match(container.textContent, /Delegation queued: opencode-1/);
    assert.match(container.textContent, /Completed/);
  } finally {
    cleanup();
  }
});

test("opencode workspace can create an initial routed delegation", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/opencode/status") {
      return {
        installed: false,
        command: "",
        detail: "OpenCode runtime was not detected.",
        installHint: "Install OpenCode with `curl -fsSL https://opencode.ai/install | bash`.",
        installCommand: "curl -fsSL https://opencode.ai/install | bash",
        alternativeInstallCommands: ["npm install -g opencode-ai"],
        configureCommand: "OPENCODE_COMMAND=/absolute/path/to/opencode",
        searchedCommands: ["opencode", "opencode-ai"],
        searchedPaths: ["~/.local/bin/opencode", "/opt/homebrew/bin/opencode"],
      };
    }
    if (route === "/addons/delegate") {
      return { id: "opencode-routed", path: "BrowserFirst/Delegations/opencode/opencode-routed.md" };
    }
    if (route === "/opencode/delegation/start") {
      return { id: "opencode-routed", path: options.body.path, status: "blocked", blockedReason: "OpenCode runtime unavailable" };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({
      container,
      bridgeRequest,
      initialMission: "Refactor the browser-first workspace command routing and return tests."
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/addons/delegate" &&
      options.body.target === "opencode" &&
      /command routing/.test(options.body.mission)
    ));
    assert.match(container.textContent, /opencode-routed/);
    assert.match(container.textContent, /Blocked: OpenCode runtime unavailable/);
    assert.match(container.textContent, /Next action: Install or start OpenCode/);
    assert.match(container.textContent, /curl -fsSL https:\/\/opencode\.ai\/install \| bash/);
    assert.match(container.textContent, /npm install -g opencode-ai/);
    assert.match(container.textContent, /OPENCODE_COMMAND=\/absolute\/path\/to\/opencode/);
    assert.match(container.textContent, /Command names checked: opencode, opencode-ai/);
    assert.match(container.textContent, /~\/\.local\/bin\/opencode/);
    assert.match(container.textContent, /OpenCode is an add-on worker/);
  } finally {
    cleanup();
  }
});

test("opencode workspace replaces raw bridge fetch failures with setup guidance", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async () => {
    throw new TypeError("Failed to fetch");
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /OpenCode status unavailable/);
    assert.match(container.textContent, /ResonantOS bridge is unreachable/);
    assert.match(container.textContent, /Settings > Bridge Target/);
    assert.doesNotMatch(container.textContent, /Failed to fetch/);

    const mission = container.querySelector("textarea");
    mission.value = "Use OpenCode to inspect a bounded file and return verification evidence.";
    container.querySelector(".opencode-task-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /OpenCode delegation failed/);
    assert.doesNotMatch(container.textContent, /Failed to fetch/);
  } finally {
    cleanup();
  }
});

test("opencode workspace wires abort, live diff refresh, and picker prompt payloads", async () => {
  const { container, cleanup, window } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) {
      return hangingSse([envelopeFrame("ses_live", { type: "file.edited", properties: { path: "src/app.js", added: 1, removed: 0 } })]);
    }
    if (route === "/opencode/status") {
      return {
        installed: true,
        proxyExecutionEnabled: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.4-mini",
        models: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4.5"],
        detail: "OpenCode runtime was detected."
      };
    }
    if (route === "/opencode/session/start") {
      return { sessionId: "ses_live" };
    }
    if (route === "/opencode/sessions/list") {
      return {
        sessions: [{ id: "ses_live", title: "Live title", created: Date.now(), updated: Date.now() }]
      };
    }
    if (route === "/opencode/agents/list") {
      return { agents: [{ name: "build" }, { name: "review" }] };
    }
    if (route === "/opencode/session/diff") {
      return { ok: true, diff: [{ path: "src/app.js", patch: "@@ -1 +1 @@\n-old\n+new" }] };
    }
    if (route === "/opencode/session/prompt" || route === "/opencode/session/abort") {
      return { ok: true };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const agent = container.querySelector(".oc-agent-picker");
    const model = container.querySelector(".oc-model-picker");
    assert.deepEqual([...agent.options].map((option) => option.value), ["build", "review"]);
    assert.deepEqual([...model.list.options].map((option) => option.value), ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4.5"]);
    agent.value = "review";
    agent.dispatchEvent(new window.Event("change", { bubbles: true }));
    model.value = "anthropic/claude-sonnet-4.5";
    model.dispatchEvent(new window.Event("input", { bubbles: true }));

    const input = container.querySelector(".oc-composer textarea");
    input.value = "run focused tests";
    container.querySelector(".oc-composer").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".oc-stop").click();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/prompt" &&
      options.body.sessionId === "ses_live" &&
      options.body.text === "run focused tests" &&
      options.body.agent === "review" &&
      options.body.model === "anthropic/claude-sonnet-4.5"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/abort" &&
      options.body.sessionId === "ses_live"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/diff" &&
      options.body.sessionId === "ses_live"
    ));
    assert.equal(container.querySelector(".oc-patch-file summary").textContent, "src/app.js");
  } finally {
    cleanup();
  }
});

test("opencode workspace ignores diff-triggering events for other sessions", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) {
      return hangingSse([envelopeFrame("ses_other", { type: "file.edited", properties: { sessionID: "ses_other", path: "src/app.js", added: 1, removed: 0 } })]);
    }
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [{ id: "ses_live", title: "Live", created: Date.now(), updated: Date.now() }] };
    if (route === "/opencode/agents/list") return { agents: [] };
    if (route === "/opencode/session/diff") return { ok: true, diff: [{ path: "src/app.js", patch: "+new" }] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.equal(calls.filter(([route]) => route === "/opencode/session/diff").length, 0);
    assert.equal(container.querySelector(".oc-patch-file"), null);
  } finally {
    cleanup();
  }
});

test("opencode workspace clears pending diff timers when switching sessions", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let startCount = 0;
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) {
      const sessionId = new URL(`http://bridge.local${route}`).searchParams.get("sessionId");
      if (sessionId === "ses_one") {
        return hangingSse([envelopeFrame("ses_one", { type: "file.edited", properties: { sessionID: "ses_one", path: "one.js", added: 1, removed: 0 } })]);
      }
      return hangingSse([]);
    }
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") {
      startCount += 1;
      return { sessionId: startCount === 1 ? "ses_one" : "ses_two" };
    }
    if (route === "/opencode/sessions/list") return {
      sessions: [
        { id: "ses_one", title: "One", created: Date.now(), updated: Date.now() },
        { id: "ses_two", title: "Two", created: Date.now(), updated: Date.now() }
      ]
    };
    if (route === "/opencode/agents/list") return { agents: [] };
    if (route === "/opencode/session/diff") return { ok: true, diff: [{ path: `${options.body.sessionId}.js`, patch: "+new" }] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".ocb-new").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.deepEqual(
      calls.filter(([route]) => route === "/opencode/session/diff").map(([, options]) => options.body.sessionId),
      []
    );
  } finally {
    cleanup();
  }
});

test("opencode workspace routes rail rename and delete actions through the bridge", async () => {
  const { container, cleanup, window } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) return hangingSse([]);
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [{ id: "ses_live", title: "Old title", created: Date.now(), updated: Date.now() }] };
    if (route === "/opencode/session/messages") return { ok: true, messages: [] };
    if (route === "/opencode/session/diff") return { ok: true, diff: [{ path: "resume.js", patch: "+resume" }] };
    if (route === "/opencode/agents/list") return { agents: [] };
    if (route === "/opencode/session/rename" || route === "/opencode/session/delete" || route === "/opencode/session/archive") return { ok: true };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({
      container,
      bridgeRequest,
      confirmSessionDelete: async () => true
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    container.querySelector(".ocb-session[data-session-id='ses_live']").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector("[data-action='rename'][data-session-id='ses_live']").click();
    container.querySelector(".ocb-rename-input").value = "Renamed title";
    container.querySelector(".ocb-rename").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector("[data-action='delete'][data-session-id='ses_live']").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/rename" &&
      options.body.sessionId === "ses_live" &&
      options.body.title === "Renamed title"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/diff" &&
      options.body.sessionId === "ses_live"
    ));
    assert.ok(calls.some(([route, options]) =>
      route === "/opencode/session/delete" &&
      options.body.sessionId === "ses_live"
    ));
    assert.equal(container.querySelector(".opencode-session-area").textContent, "");
  } finally {
    cleanup();
  }
});

test("opencode external cockpit button is hidden unless execution is enabled", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/opencode/status") {
      return {
        installed: true,
        executionEnabled: false,
        command: "/usr/local/bin/opencode",
        detail: "OpenCode runtime was detected but execution is disabled.",
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cockpitButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open full cockpit (external, ungoverned)");
    assert.ok(cockpitButton);
    assert.equal(cockpitButton.hidden, true);
    assert.equal(container.querySelector("iframe"), null);
  } finally {
    cleanup();
  }
});

test("opencode external cockpit interstitial gates URL issuance and opens with noopener noreferrer", async () => {
  const { container, cleanup, window } = setupDom();
  const calls = [];
  const openCalls = [];
  window.open = (...args) => {
    openCalls.push(args);
    return null;
  };
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/opencode/status") {
      return {
        installed: true,
        executionEnabled: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.4-mini",
        detail: "OpenCode runtime was detected.",
      };
    }
    if (route === "/opencode/web/url") {
      return { url: "http://127.0.0.1:4231/" };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cockpitButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open full cockpit (external, ungoverned)");
    assert.ok(cockpitButton);
    assert.equal(cockpitButton.hidden, false);
    cockpitButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(container.textContent, /LOCAL and UNGOVERNED/);
    assert.match(container.textContent, /bypass ResonantOS approvals, redaction, and audit/);
    assert.equal(openCalls.length, 0);
    assert.equal(calls.filter(([route]) => route === "/opencode/web/url").length, 0);

    const cancel = [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    cancel.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(openCalls.length, 0);
    assert.equal(calls.filter(([route]) => route === "/opencode/web/url").length, 0);

    cockpitButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Open in browser tab");
    confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(calls.some(([route, options]) => route === "/opencode/web/url" && options.method === "POST"));
    assert.deepEqual(openCalls, [["http://127.0.0.1:4231/", "_blank", "noopener,noreferrer"]]);
    assert.equal(container.querySelector("iframe"), null);
  } finally {
    cleanup();
  }
});

test("cockpit open does not window.open when requiresCredential", async () => {
  const { container, cleanup, window } = setupDom();
  const openCalls = [];
  window.open = (...args) => {
    openCalls.push(args);
    return null;
  };
  const bridgeRequest = async (route) => {
    if (route === "/opencode/status") {
      return {
        installed: true,
        executionEnabled: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.4-mini",
        detail: "OpenCode runtime was detected.",
      };
    }
    if (route === "/opencode/web/url") {
      return { url: "http://127.0.0.1:45123/", requiresCredential: true };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cockpitButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open full cockpit (external, ungoverned)");
    cockpitButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cockpitOpen = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Open in browser tab");
    cockpitOpen.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cockpitStatus = container.querySelector(".opencode-cockpit-status");
    assert.deepEqual(openCalls, []);
    assert.match(cockpitStatus.textContent, /disabled/);
    assert.equal(cockpitOpen.disabled, false);
  } finally {
    cleanup();
  }
});

test("live session events use the bridge SSE route on start", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) return hangingSse([]);
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [{ id: "ses_live", title: "Live", created: Date.now(), updated: Date.now() }] };
    if (route === "/opencode/agents/list") return { agents: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventsCall = calls.find(([route, options]) => isEventsRoute(route, options));
    assert.deepEqual(
      [eventsCall?.[0], eventsCall?.[1]?.responseType, eventsCall?.[1]?.method ?? "GET"],
      ["/opencode/session/events?sessionId=ses_live", "sse", "GET"]
    );
  } finally {
    cleanup();
  }
});

test("live session events use the bridge SSE route on resume", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) return hangingSse([]);
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [{ id: "ses_live", title: "Live", created: Date.now(), updated: Date.now() }] };
    if (route === "/opencode/session/messages") return { ok: true, messages: [] };
    if (route === "/opencode/agents/list") return { agents: [] };
    if (route === "/opencode/session/diff") return { ok: true, diff: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".ocb-session[data-session-id='ses_live']").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumeCalls = calls.filter(([route, options]) => isEventsRoute(route, options));
    assert.equal(resumeCalls.some(([route]) => route === "/opencode/session/events?sessionId=ses_live"), true);
  } finally {
    cleanup();
  }
});

test("event stream requests never include a Basic Authorization header", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (isEventsRoute(route, options)) return hangingSse([]);
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [] };
    if (route === "/opencode/agents/list") return { agents: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventsCall = calls.find(([route, options]) => isEventsRoute(route, options));
    assert.equal(Boolean(eventsCall?.[1]?.headers?.Authorization), false);
  } finally {
    cleanup();
  }
});

test("rendered status text never includes connection credential fields", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route, options = {}) => {
    if (isEventsRoute(route, options)) return hangingSse([]);
    if (route === "/opencode/status") return { installed: true, proxyExecutionEnabled: true, command: "/usr/local/bin/opencode", model: "openai/gpt-5.4-mini", detail: "Ready" };
    if (route === "/opencode/session/start") return { sessionId: "ses_live" };
    if (route === "/opencode/sessions/list") return { sessions: [] };
    if (route === "/opencode/agents/list") return { agents: [] };
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.doesNotMatch(container.textContent, /eventAuthorization|eventUrl|baseUrl/);
  } finally {
    cleanup();
  }
});
