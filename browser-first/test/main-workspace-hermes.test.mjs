import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderHermesDashboardWorkspace } from "../resonantos-side-panel-extension/src/lib/main-workspace-hermes.js";

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

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Hermes workspace renders CLI, execution, dashboard, task, and boundary state", async () => {
  const { container, cleanup } = setupDom();
  const calls = [];
  const bridgeRequest = async (route, options = {}) => {
    calls.push([route, options]);
    if (route === "/hermes/dashboard/status") {
      return {
        detail: "Hermes dashboard is not reachable at http://127.0.0.1:9119.",
        rawStatus: "Hermes CLI found.",
        running: false,
        url: "http://127.0.0.1:9119"
      };
    }
    if (route === "/hermes/status") {
      return {
        available: true,
        boundary: "Hermes is an add-on agent.",
        dashboard: { running: false, url: "http://127.0.0.1:9119" },
        executionEnabled: false,
        mode: "local-hermes-cli-disabled",
        taskCounts: { blocked: 1, queued: 2 }
      };
    }
    if (route === "/hermes/dashboard/start") {
      return {
        detail: "Hermes dashboard is still stopped.",
        rawStatus: "Hermes CLI found.",
        running: false,
        url: "http://127.0.0.1:9119"
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderHermesDashboardWorkspace({
      container,
      bridgeRequest,
      statusForAddon: async () => ({
        available: true,
        execution: { runtimeAvailable: true },
        id: "addon.hermes",
        name: "Hermes"
      })
    });
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /Hermes CLI found/);
    assert.match(container.textContent, /CLI detected · execution disabled · local-hermes-cli-disabled/);
    assert.match(container.textContent, /Tasks: blocked: 1, queued: 2/);
    assert.match(container.textContent, /Boundary: Hermes is an add-on agent/);
    assert.ok(calls.some(([route]) => route === "/hermes/status"));
  } finally {
    cleanup();
  }
});

test("Hermes workspace reports bundled contract separately from missing local CLI runtime", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async (route) => {
    if (route === "/hermes/dashboard/status" || route === "/hermes/dashboard/start") {
      return {
        detail: "Hermes dashboard is not reachable at http://127.0.0.1:9119.",
        rawStatus: "Hermes CLI was not found.",
        running: false,
        url: "http://127.0.0.1:9119"
      };
    }
    if (route === "/hermes/status") {
      return {
        available: false,
        dashboard: { running: false, url: "http://127.0.0.1:9119" },
        executionEnabled: false,
        mode: "packet-only",
        taskCounts: {}
      };
    }
    throw new Error(`Unexpected route ${route}`);
  };

  try {
    renderHermesDashboardWorkspace({
      container,
      bridgeRequest,
      statusForAddon: async () => ({
        available: true,
        execution: { runtimeAvailable: false },
        id: "addon.hermes",
        name: "Hermes"
      })
    });
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /CLI not detected · execution disabled · packet-only/);
    assert.match(container.textContent, /Tasks: no recorded tasks/);
    assert.match(container.textContent, /add-on contract is installed, but the local Hermes CLI runtime was not detected/);
    assert.match(container.textContent, /Blocked: Hermes runtime was not detected/);
    assert.match(container.textContent, /Next action: Install or start Hermes/);
    assert.match(container.textContent, /Hermes is an add-on worker/);
  } finally {
    cleanup();
  }
});

test("Hermes workspace replaces raw bridge fetch failures with setup guidance", async () => {
  const { container, cleanup } = setupDom();
  const bridgeRequest = async () => {
    throw new TypeError("Failed to fetch");
  };

  try {
    renderHermesDashboardWorkspace({
      container,
      bridgeRequest,
      statusForAddon: async () => ({
        available: true,
        execution: { runtimeAvailable: true },
        id: "addon.hermes",
        name: "Hermes"
      })
    });
    await waitTick();
    await waitTick();

    assert.match(container.textContent, /Hermes status unavailable/);
    assert.match(container.textContent, /ResonantOS bridge is unreachable/);
    assert.match(container.textContent, /Settings > Bridge Target/);
    assert.doesNotMatch(container.textContent, /Failed to fetch/);
  } finally {
    cleanup();
  }
});
