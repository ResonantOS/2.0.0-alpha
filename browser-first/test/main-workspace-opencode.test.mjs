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
