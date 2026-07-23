import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const HOST_ROOT = path.resolve(import.meta.dirname, "..", "host");
const COMPOSITION_PATH = path.join(
  HOST_ROOT,
  "opencode-session-composition.mjs",
);

function route(routes, routePath) {
  return routes.find(({ path: candidate }) => candidate === routePath);
}

function waitingEventStream(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  };
}

test("production OpenCode composition uses persisted preflight and scoped lifecycle inputs", async () => {
  const source = await readFile(COMPOSITION_PATH, "utf8").catch(() => "");
  assert.match(
    source,
    /export function createOpencodeSessionBridgeComposition/,
    "the bridge-owned OpenCode composition module must exist",
  );

  const {
    createOpencodeSessionBridgeComposition,
  } = await import(`${pathToFileURL(COMPOSITION_PATH).href}?test=${Date.now()}`);
  const child = new EventEmitter();
  child.exitCode = null;
  const handle = Object.freeze({ process: child });
  const calls = [];
  let revoked = false;
  const lifecycle = {
    async createClient(receivedHandle) {
      calls.push(["createClient", receivedHandle]);
      return {
        async createSession(input) {
          calls.push(["createSession", input]);
          return { sessionId: "owned-session" };
        },
        async prompt() {},
        async replyPermission() {},
        async subscribeEvents({ signal }) {
          return waitingEventStream(signal);
        },
      };
    },
    async shutdown() {
      calls.push(["lifecycle.shutdown"]);
    },
    async start(input) {
      calls.push(["lifecycle.start", input]);
      return handle;
    },
    async stop(receivedHandle, context) {
      calls.push(["lifecycle.stop", receivedHandle, context]);
    },
  };
  const addonDelegationService = {
    async executeAddonExecutionSettingsUpdate(payload) {
      calls.push(["settings.update", payload]);
      return { stopRequired: false };
    },
    async executeOpenCodeLiveSessionPreflight(options) {
      calls.push(["preflight", options]);
      if (revoked) {
        const error = new Error("host consent revoked");
        error.stopRequired = true;
        throw error;
      }
      return {
        childEnvironment: {
          HOME: "/Users/test",
          MINIMAX_API_KEY: "host-selected-secret",
        },
        command: "/fixed/bin/opencode",
        model: "minimax/MiniMax-M2.1",
        workspaceLabel: ".",
        workspacePath: "/approved/repository",
      };
    },
  };
  const composition = createOpencodeSessionBridgeComposition({
    addonDelegationService,
    lifecycle,
  });

  const started = await route(
    composition.opencodeSessionRoutes,
    "/opencode/session/start",
  ).handler({
    workspacePath: "/caller/override",
    model: "caller/model",
    env: { FOREIGN_SECRET: "caller-secret" },
  });

  assert.deepEqual(started, {
    sessionId: "owned-session",
    workspace: ".",
  });
  assert.deepEqual(calls.slice(0, 4), [
    ["preflight", { activeSession: false }],
    ["lifecycle.start", {
      command: "/fixed/bin/opencode",
      cwd: "/approved/repository",
      env: {
        HOME: "/Users/test",
        MINIMAX_API_KEY: "host-selected-secret",
      },
    }],
    ["createClient", handle],
    ["createSession", {
      directory: "/approved/repository",
      model: "minimax/MiniMax-M2.1",
    }],
  ]);
  assert.equal(JSON.stringify(started).includes("/approved/repository"), false);
  assert.equal(JSON.stringify(started).includes("host-selected-secret"), false);

  revoked = true;
  await assert.rejects(
    route(
      composition.opencodeSessionRoutes,
      "/opencode/session/start",
    ).handler({}),
    /host consent revoked/,
  );
  assert.equal(
    calls.some(([name, receivedHandle]) => (
      name === "lifecycle.stop" && receivedHandle === handle
    )),
    true,
  );

  await composition.shutdownOpenCodeSession();
  assert.equal(
    calls.some(([name]) => name === "lifecycle.shutdown"),
    true,
  );
});

test("settings revocation stops the active OpenCode session without another session request", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const handle = Object.freeze({ process: child });
  const calls = [];
  const lifecycle = {
    async createClient() {
      return {
        async createSession() {
          return { sessionId: "owned-session" };
        },
        async prompt() {},
        async replyPermission() {},
        async subscribeEvents({ signal }) {
          return waitingEventStream(signal);
        },
      };
    },
    async shutdown() {},
    async start() {
      return handle;
    },
    async stop(receivedHandle, context) {
      calls.push(["lifecycle.stop", receivedHandle, context]);
    },
  };
  const addonDelegationService = {
    async executeAddonExecutionSettingsUpdate(payload) {
      calls.push(["settings.update", payload]);
      return {
        addon: "opencode",
        stopRequired: true,
      };
    },
    async executeOpenCodeLiveSessionPreflight() {
      return {
        childEnvironment: {},
        command: "/fixed/bin/opencode",
        model: "minimax/MiniMax-M2.1",
        workspaceLabel: ".",
        workspacePath: "/approved/repository",
      };
    },
  };
  const { createOpencodeSessionBridgeComposition } = await import(
    `${pathToFileURL(COMPOSITION_PATH).href}?revocation=${Date.now()}`
  );
  const composition = createOpencodeSessionBridgeComposition({
    addonDelegationService,
    lifecycle,
  });
  await route(
    composition.opencodeSessionRoutes,
    "/opencode/session/start",
  ).handler({});

  const updated = await composition.executeAddonExecutionSettingsUpdate({
    addon: "opencode",
    liveSession: { enabled: false },
  });

  assert.deepEqual(updated, {
    addon: "opencode",
    stopRequired: true,
  });
  assert.equal(calls.filter(([name]) => name === "lifecycle.stop").length, 1);
  await assert.rejects(
    () => route(
      composition.opencodeSessionRoutes,
      "/opencode/session/prompt",
    ).handler({
      sessionId: "owned-session",
      text: "must not run",
    }),
    /no active OpenCode session/i,
  );
});

test("run bridge uses the governed composition and removes the raw fixed-port prototype", async () => {
  const source = await readFile(
    path.join(HOST_ROOT, "run-bridge-minimal.mjs"),
    "utf8",
  );

  assert.match(source, /createOpencodeSessionBridgeComposition/);
  assert.doesNotMatch(source, /createOpencodeHttpClient/);
  assert.doesNotMatch(source, /ensureOpencodeServer/);
  assert.doesNotMatch(source, /RESONANTOS_OPENCODE_PORT/);
  assert.doesNotMatch(source, /\b4231\b/);
  assert.doesNotMatch(source, /env:\s*process\.env/);
  assert.match(source, /shutdownOpenCodeSession/);
  assert.match(source, /executeAddonExecutionSettingsUpdate/);
  assert.doesNotMatch(source, /shutdownOpenCodeSession\(\)\.catch\(\(\) => undefined\)/);
  assert.equal(
    source.match(/\bclearSessionProviderSecrets\b/g)?.length,
    2,
    "the bridge must acquire and invoke provider session-secret cleanup",
  );
});
