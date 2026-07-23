import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderOpenCodeWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-opencode.js";

function setupDom() {
  const dom = new JSDOM("<!doctype html><main id=\"root\"></main>", { url: "https://resonantos.local/" });
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  return {
    container: dom.window.document.querySelector("#root"),
    cleanup: () => {
      delete globalThis.document;
      delete globalThis.HTMLElement;
      delete globalThis.Event;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
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
        delegationPackets: 1,
        liveSession: {
          enabled: true,
          workspaceConfigured: true,
          workspacePath: "packages/governed-workspace",
          grantedCapabilities: ["filesystem", "providers"],
          ready: true,
          readinessReasons: []
        }
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
        liveSession: {
          enabled: false,
          workspaceConfigured: false,
          workspacePath: "",
          grantedCapabilities: [],
          ready: false,
          readinessReasons: ["runtime-unavailable"]
        }
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

test("live session controls follow host readiness and never consume a raw OpenCode URL", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  let ready = false;
  let sourceOptions = null;
  let sourceCreates = 0;
  let sourceStarts = 0;
  let sourceStops = 0;
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/opencode/status") {
      return {
        installed: true,
        executionEnabled: true,
        command: "/usr/local/bin/opencode",
        model: "openai/gpt-5.6",
        detail: "OpenCode runtime was detected.",
        liveSession: ready
          ? {
              enabled: true,
              workspaceConfigured: true,
              workspacePath: "packages/governed-workspace",
              grantedCapabilities: ["filesystem", "providers"],
              ready: true,
              readinessReasons: []
            }
          : {
              enabled: false,
              workspaceConfigured: true,
              workspacePath: "packages/governed-workspace",
              grantedCapabilities: ["filesystem"],
              ready: false,
              readinessReasons: ["live-session-disabled", "capability-providers-required"]
            }
      };
    }
    if (route === "/opencode/session/start") {
      const result = {
        sessionId: "session-owned",
        workspace: "packages/governed-workspace"
      };
      Object.defineProperty(result, "eventUrl", {
        get() {
          throw new Error("Raw OpenCode URLs must not be read by the extension.");
        }
      });
      return result;
    }
    if (route === "/opencode/session/stop") {
      return { stopped: true };
    }
    if (route === "/opencode/session/events") {
      return { droppedBefore: 0, events: [], nextCursor: 0 };
    }
    throw new Error(`Unexpected route ${route}`);
  };
  const createBridgeSource = (options) => {
    sourceCreates += 1;
    sourceOptions = options;
    let session = null;
    return {
      async start() {
        sourceStarts += 1;
        session = await options.startSession();
        return { sessionId: session.sessionId, workspace: session.workspace };
      },
      subscribe() {
        return () => {};
      },
      async sendPrompt() {},
      async replyPermission() {},
      async stop() {
        sourceStops += 1;
        return options.postJson("/opencode/session/stop", { sessionId: session.sessionId });
      }
    };
  };

  try {
    renderOpenCodeWorkspace({ container, bridgeRequest, createBridgeSource });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const start = container.querySelector(".opencode-start-session");
    assert.equal(start.hidden, false);
    assert.equal(start.disabled, true);
    assert.match(container.querySelector(".opencode-live-readiness").textContent, /live session is disabled/i);
    assert.match(container.querySelector(".opencode-live-readiness").textContent, /provider capability is required/i);

    ready = true;
    container.querySelector(".opencode-status-card button").dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(start.disabled, false);

    start.dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sourceCreates, 1);
    assert.equal(sourceStarts, 1);
    assert.equal(Object.hasOwn(sourceOptions, "openEventStream"), false);
    assert.equal(container.querySelector(".oc-scope").textContent, "scope: packages/governed-workspace");

    const pollController = new AbortController();
    await sourceOptions.postJson(
      "/opencode/session/events",
      { sessionId: "session-owned", after: 0 },
      { signal: pollController.signal }
    );
    const pollCall = calls.find(([route]) => route === "/opencode/session/events");
    assert.equal(pollCall?.[1]?.signal, pollController.signal);

    sourceOptions.onCursorGap({ requestedAfter: 1, droppedBefore: 4 });
    assert.match(container.querySelector(".oc-session-notice").textContent, /earlier OpenCode events expired/i);
    sourceOptions.onPollingError(new Error("private runtime failure"));
    assert.match(container.querySelector(".oc-session-notice").textContent, /session ended/i);
    assert.doesNotMatch(container.querySelector(".oc-session-notice").textContent, /private runtime failure/i);

    container.querySelector(".oc-stop-session").dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sourceStops, 1);
    assert.equal(container.querySelector(".oc-session"), null);
    assert.equal(container.querySelector(".opencode-hero").hidden, false);
    assert.ok(calls.some(([route]) => route === "/opencode/session/stop"));
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

test("workspace disposal stops one active source and destroys its session exactly once", async () => {
  const { container, cleanup } = setupDom();
  let sourceStops = 0;
  let sessionDestroys = 0;
  const bridgeRequest = async (route) => {
    if (route === "/opencode/status") {
      return {
        installed: true,
        detail: "OpenCode runtime was detected.",
        liveSession: {
          enabled: true,
          workspaceConfigured: true,
          workspacePath: ".",
          grantedCapabilities: ["filesystem", "providers"],
          ready: true,
          readinessReasons: []
        }
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };
  const source = {
    async start() {
      return { sessionId: "session-dispose", workspace: "." };
    },
    subscribe() {
      return () => {};
    },
    async sendPrompt() {},
    async replyPermission() {},
    async stop() {
      sourceStops += 1;
      return { stopped: true };
    }
  };

  try {
    const dispose = renderOpenCodeWorkspace({
      container,
      bridgeRequest,
      createBridgeSource: () => source,
      createSession: () => ({
        destroy() {
          sessionDestroys += 1;
        }
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(typeof dispose, "function");
    await Promise.all([dispose(), dispose()]);
    assert.equal(sourceStops, 1);
    assert.equal(sessionDestroys, 1);
  } finally {
    cleanup();
  }
});

test("workspace disposal waits for an in-flight source start and prevents a late mount", async () => {
  const { container, cleanup } = setupDom();
  const started = deferred();
  let sourceStops = 0;
  let sessionCreates = 0;
  const bridgeRequest = async (route) => {
    if (route === "/opencode/status") {
      return {
        installed: true,
        detail: "OpenCode runtime was detected.",
        liveSession: {
          enabled: true,
          workspaceConfigured: true,
          workspacePath: ".",
          grantedCapabilities: ["filesystem", "providers"],
          ready: true,
          readinessReasons: []
        }
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };
  const source = {
    start() {
      return started.promise;
    },
    subscribe() {
      return () => {};
    },
    async sendPrompt() {},
    async replyPermission() {},
    async stop() {
      sourceStops += 1;
      await started.promise;
      return { stopped: true };
    }
  };

  try {
    const dispose = renderOpenCodeWorkspace({
      container,
      bridgeRequest,
      createBridgeSource: () => source,
      createSession: () => {
        sessionCreates += 1;
        return { destroy() {} };
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    container.querySelector(".opencode-start-session").dispatchEvent(new Event("click"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const disposed = dispose();
    started.resolve({ sessionId: "session-late", workspace: "." });
    await disposed;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sourceStops, 1);
    assert.equal(sessionCreates, 0);
    assert.equal(container.querySelector(".oc-session"), null);
  } finally {
    cleanup();
  }
});
