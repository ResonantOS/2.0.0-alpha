import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHermesRuntimeStatusMessage,
  formatHermesRuntimeStatus
} from "../resonantos-side-panel-extension/src/lib/addon-runtime-status.js";

test("Hermes runtime status explains unavailable CLI and next action", () => {
  const message = formatHermesRuntimeStatus({
    available: false,
    dashboard: { running: false, url: "http://127.0.0.1:9119" },
    executionEnabled: false,
    mode: "packet-only",
    taskCounts: { queued: 2 }
  });

  assert.match(message, /Hermes runtime status/);
  assert.match(message, /CLI: not detected/);
  assert.match(message, /Execution: disabled/);
  assert.match(message, /Tasks: queued: 2/);
  assert.match(message, /Install or configure the Hermes CLI/);
});

test("Hermes runtime status reports ready governed delegation path", async () => {
  const calls = [];
  const message = await buildHermesRuntimeStatusMessage({
    bridgeRequest: async (route, options) => {
      calls.push([route, options]);
      return {
        available: true,
        command: "~/bin/hermes",
        dashboard: { running: true, url: "http://127.0.0.1:9119" },
        executionEnabled: true,
        mode: "local-hermes-cli",
        taskCounts: { completed: 1, running: 1 },
        boundary: "host mediated"
      };
    }
  });

  assert.deepEqual(calls, [["/hermes/status", { method: "POST", body: {} }]]);
  assert.match(message, /CLI: detected/);
  assert.match(message, /Command: ~\/bin\/hermes/);
  assert.match(message, /Dashboard: running/);
  assert.match(message, /Tasks: completed: 1, running: 1/);
  assert.match(message, /Use `\/hermes <mission>`/);
});

test("Hermes runtime status degrades safely when bridge fails", async () => {
  const message = await buildHermesRuntimeStatusMessage({
    bridgeRequest: async () => {
      throw new Error("bridge unavailable");
    }
  });

  assert.match(message, /Hermes runtime status/);
  assert.match(message, /bridge unavailable/);
  assert.match(message, /Settings > Add-ons/);
});

test("Hermes runtime status replaces raw fetch failures with bridge setup guidance", async () => {
  const message = await buildHermesRuntimeStatusMessage({
    bridgeRequest: async () => {
      throw new TypeError("Failed to fetch");
    }
  });

  assert.match(message, /Hermes runtime status/);
  assert.match(message, /ResonantOS bridge is unreachable/);
  assert.match(message, /Settings > Bridge Target/);
  assert.doesNotMatch(message, /Failed to fetch/);
});
