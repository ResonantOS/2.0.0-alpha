import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  allocateLoopbackPort,
  createOpencodeSdkClient,
  createOpencodeServerLifecycle,
  readOpencodeServerBaseUrl,
  splitOpencodeModelIdentifier,
} from "../host/opencode-client.mjs";

const PORT = 43123;
const WORKSPACE = "/approved/workspace";
const CONFIG_DIRECTORY = "/private/tmp/resonantos-opencode-config-test";
const PASSWORD = "generated-server-password";
const AUTHORIZATION = `Basic ${Buffer.from(`resonantos:${PASSWORD}`).toString("base64")}`;

function fakeChild({ exitOnKill = true } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killCalls = 0;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killCalls += 1;
    child.killSignals.push(signal);
    if (exitOnKill) {
      queueMicrotask(() => {
        if (child.exitCode !== null) return;
        child.exitCode = 0;
        child.emit("exit", 0, null);
      });
    }
    return true;
  };
  return child;
}

function response(ok, status = ok ? 200 : 401) {
  return { ok, status };
}

function lifecycleHarness(overrides = {}) {
  const child = overrides.child ?? fakeChild();
  const clients = [];
  const removedDirectories = [];
  const spawnCalls = [];
  const fetchCalls = [];
  const createClient = overrides.createClient ?? (async (options) => {
    clients.push(options);
    return { sdk: true };
  });
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    fetchCalls.push({ url, options });
    return response(options.headers.Authorization === AUTHORIZATION);
  });
  const spawnImpl = overrides.spawnImpl ?? ((command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  });
  const lifecycle = createOpencodeServerLifecycle({
    createClient,
    createConfigDirectory: overrides.createConfigDirectory ?? (async () => CONFIG_DIRECTORY),
    fetchImpl,
    readServerAddress: overrides.readServerAddress ?? (async () => (
      `http://127.0.0.1:${PORT}`
    )),
    randomPassword: overrides.randomPassword ?? (() => PASSWORD),
    removeConfigDirectory: overrides.removeConfigDirectory ?? (async (directory) => {
      removedDirectories.push(directory);
    }),
    sleep: overrides.sleep ?? (async () => {}),
    spawnImpl,
    pollMs: overrides.pollMs ?? 1,
    readinessProbeTimeoutMs: overrides.readinessProbeTimeoutMs ?? 10,
    readinessTimeoutMs: overrides.readinessTimeoutMs ?? 50,
    maxStartAttempts: overrides.maxStartAttempts ?? 3,
    terminationGraceMs: overrides.terminationGraceMs ?? 10,
    terminationKillTimeoutMs: overrides.terminationKillTimeoutMs ?? 10,
  });
  return {
    child,
    clients,
    fetchCalls,
    lifecycle,
    removedDirectories,
    spawnCalls,
  };
}

test("allocateLoopbackPort binds loopback on an ephemeral exclusive port and closes the probe", async () => {
  const calls = [];
  const server = {
    once(event, listener) {
      calls.push(["once", event, listener]);
    },
    removeListener(event, listener) {
      calls.push(["removeListener", event, listener]);
    },
    listen(options, listener) {
      calls.push(["listen", options]);
      listener();
    },
    address() {
      return { address: "127.0.0.1", family: "IPv4", port: PORT };
    },
    close(listener) {
      calls.push(["close"]);
      listener();
    },
  };

  const port = await allocateLoopbackPort({ createServerImpl: () => server });

  assert.equal(port, PORT);
  assert.deepEqual(calls.find(([name]) => name === "listen"), [
    "listen",
    { host: "127.0.0.1", port: 0, exclusive: true },
  ]);
  assert.equal(calls.some(([name]) => name === "close"), true);
});

test("splitOpencodeModelIdentifier splits once and rejects invalid identifiers", () => {
  assert.deepEqual(splitOpencodeModelIdentifier("openai/gpt-5.4-mini"), {
    providerID: "openai",
    id: "gpt-5.4-mini",
  });
  assert.deepEqual(splitOpencodeModelIdentifier("openrouter/google/gemini-2.5-pro"), {
    providerID: "openrouter",
    id: "google/gemini-2.5-pro",
  });
  for (const value of ["", "openai", "/model", "openai/", " openai/model", "openai/model "]) {
    assert.throws(() => splitOpencodeModelIdentifier(value), /provider\/model/);
  }
});

test("SDK adapter uses the exact authenticated v2 client and session contracts", async () => {
  const calls = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield { type: "session.idle", data: { sessionID: "session-1" } };
    },
  };
  const rawClient = {
    v2: {
      event: {
        subscribe: async (options) => {
          calls.push(["subscribe", options]);
          return { stream };
        },
      },
      session: {
        create: async (input) => {
          calls.push(["create", input]);
          return { data: { data: { id: "session-1" } } };
        },
        permission: {
          reply: async (input) => {
            calls.push(["permission", input]);
            return { data: { data: { accepted: true } } };
          },
        },
        prompt: async (input) => {
          calls.push(["prompt", input]);
          return { data: { data: { accepted: true } } };
        },
      },
    },
  };
  const createCalls = [];
  const client = await createOpencodeSdkClient({
    authorization: AUTHORIZATION,
    baseUrl: `http://127.0.0.1:${PORT}`,
    directory: WORKSPACE,
    loadSdk: async () => ({
      createOpencodeClient: (options) => {
        createCalls.push(options);
        return rawClient;
      },
    }),
  });
  const abortController = new AbortController();

  assert.deepEqual(await client.createSession({ model: "openai/gpt-5.4-mini" }), {
    sessionId: "session-1",
  });
  await client.prompt({ sessionID: "session-1", text: "Run tests." });
  await client.replyPermission({
    sessionID: "session-1",
    requestID: "permission-1",
    reply: "once",
  });
  assert.equal(await client.subscribeEvents({ signal: abortController.signal }), stream);

  assert.deepEqual(createCalls, [{
    baseUrl: `http://127.0.0.1:${PORT}`,
    directory: WORKSPACE,
    headers: { Authorization: AUTHORIZATION },
    throwOnError: true,
  }]);
  assert.deepEqual(calls, [
    ["create", {
      model: { providerID: "openai", id: "gpt-5.4-mini" },
      location: { directory: WORKSPACE },
    }],
    ["prompt", {
      sessionID: "session-1",
      prompt: { text: "Run tests." },
      delivery: "queue",
    }],
    ["permission", {
      sessionID: "session-1",
      requestID: "permission-1",
      reply: "once",
    }],
    ["subscribe", {
      signal: abortController.signal,
      sseMaxRetryAttempts: 1,
    }],
  ]);
});

test("SDK adapter rejects persistent permission replies and invalid models before an SDK request", async () => {
  let createCalls = 0;
  let permissionCalls = 0;
  const client = await createOpencodeSdkClient({
    authorization: AUTHORIZATION,
    baseUrl: `http://127.0.0.1:${PORT}`,
    directory: WORKSPACE,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          event: { subscribe: async () => ({ stream: [] }) },
          session: {
            create: async () => {
              createCalls += 1;
            },
            permission: {
              reply: async () => {
                permissionCalls += 1;
              },
            },
            prompt: async () => ({}),
          },
        },
      }),
    }),
  });

  await assert.rejects(client.createSession({ model: "missing-provider" }), /provider\/model/);
  await assert.rejects(
    client.replyPermission({
      sessionID: "session-1",
      requestID: "permission-1",
      reply: "always",
    }),
    /once or reject/,
  );
  assert.equal(createCalls, 0);
  assert.equal(permissionCalls, 0);
});

test("lifecycle starts one authenticated pure loopback child with scoped environment", async () => {
  const originalPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const {
    child,
    clients,
    fetchCalls,
    lifecycle,
    spawnCalls,
  } = lifecycleHarness();
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {
      HOME: "/Users/test",
      MINIMAX_API_KEY: "fixture-key",
      OPENCODE_SERVER_PASSWORD: "foreign-password",
      OPENCODE_SERVER_USERNAME: "foreign-user",
      RESONANTOS_BROWSER_FIRST_TOKEN: "bridge-secret",
    },
  });

  assert.equal(handle.process, child);
  assert.deepEqual(lifecycle.status(), { state: "running" });
  assert.deepEqual(spawnCalls, [{
    command: "/fixed/bin/opencode",
    args: ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
    options: {
      cwd: WORKSPACE,
      env: {
        HOME: "/Users/test",
        MINIMAX_API_KEY: "fixture-key",
        OPENCODE_CONFIG_DIR: CONFIG_DIRECTORY,
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_PERMISSION: "{\"*\":\"deny\",\"read\":{\"*\":\"ask\",\"*.env\":\"deny\",\"*.env.*\":\"deny\",\"*.env.example\":\"ask\"},\"edit\":\"ask\",\"glob\":\"ask\",\"grep\":\"ask\",\"list\":\"ask\",\"todowrite\":\"allow\",\"bash\":\"deny\",\"task\":\"deny\",\"lsp\":\"deny\",\"external_directory\":\"deny\"}",
        OPENCODE_SERVER_USERNAME: "resonantos",
        OPENCODE_SERVER_PASSWORD: PASSWORD,
      },
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    },
  }]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].options.headers.Authorization, AUTHORIZATION);
  assert.equal(fetchCalls[1].options.headers.Authorization, undefined);
  assert.equal(process.env.OPENCODE_SERVER_PASSWORD, originalPassword);

  const sensitiveTextRedactor = handle.createSensitiveTextRedactor();
  const redactedServiceCredential = [
    ...PASSWORD,
  ].map((character) => sensitiveTextRedactor.write(character)).join("")
    + sensitiveTextRedactor.flush();
  assert.equal(redactedServiceCredential.includes(PASSWORD), false);
  assert.match(redactedServiceCredential, /\[redacted\]/);

  assert.deepEqual(await lifecycle.createClient(handle), { sdk: true });
  assert.deepEqual(clients, [{
    authorization: AUTHORIZATION,
    baseUrl: `http://127.0.0.1:${PORT}`,
    directory: WORKSPACE,
  }]);
});

test("lifecycle rejects a loopback server that does not enforce its generated credential", async () => {
  const child = fakeChild();
  const { fetchCalls, lifecycle } = lifecycleHarness({
    child,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return response(true, 200);
    },
    maxStartAttempts: 1,
  });

  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /did not enforce authentication/i,
  );
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].options.headers.Authorization, AUTHORIZATION);
  assert.equal(fetchCalls[1].options.headers.Authorization, undefined);
  assert.equal(child.killCalls, 1);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
});

test("lifecycle readiness closes authenticated and unauthenticated probe bodies", async () => {
  const cancelledBodies = [];
  const { lifecycle } = lifecycleHarness({
    fetchImpl: async (_url, options) => ({
      ok: Boolean(options.headers.Authorization),
      status: options.headers.Authorization ? 200 : 401,
      body: {
        async cancel() {
          cancelledBodies.push(options.headers.Authorization ? "owned" : "unowned");
        },
      },
    }),
  });

  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  assert.deepEqual(cancelledBodies, ["owned", "unowned"]);
  await lifecycle.stop(handle);
});

test("lifecycle delegates port selection to its child and sends no fixed challenge probe", async () => {
  const {
    fetchCalls,
    lifecycle,
    spawnCalls,
  } = lifecycleHarness();

  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  assert.deepEqual(
    spawnCalls[0].args,
    ["serve", "--pure", "--hostname", "127.0.0.1", "--port", "0"],
  );
  assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].options.headers.Authorization, AUTHORIZATION);
  assert.equal(fetchCalls[1].options.headers.Authorization, undefined);
  await lifecycle.stop(handle);
});

test("lifecycle handle and public status expose no URL, credentials, config path, or workspace", async () => {
  const { lifecycle } = lifecycleHarness();
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });
  const publicText = JSON.stringify({ handle, status: lifecycle.status() });

  for (const value of [
    `http://127.0.0.1:${PORT}`,
    AUTHORIZATION,
    PASSWORD,
    CONFIG_DIRECTORY,
    WORKSPACE,
  ]) {
    assert.equal(publicText.includes(value), false);
  }
});

test("server address reader accepts only the owned child's strict loopback announcement", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  const reading = readOpencodeServerBaseUrl(child, { timeoutMs: 50 });
  queueMicrotask(() => {
    child.stdout.emit(
      "data",
      Buffer.from(`opencode server listening on http://127.0.0.1:${PORT}\n`),
    );
  });

  assert.equal(await reading, `http://127.0.0.1:${PORT}`);
});

test("server address reader rejects foreign and oversized announcements", async () => {
  const foreignChild = new EventEmitter();
  foreignChild.stdout = new EventEmitter();
  foreignChild.stdout.resume = () => {};
  const foreignReading = readOpencodeServerBaseUrl(foreignChild, { timeoutMs: 5 });
  queueMicrotask(() => {
    foreignChild.stdout.emit(
      "data",
      Buffer.from(`opencode server listening on http://0.0.0.0:${PORT}\n`),
    );
  });
  await assert.rejects(foreignReading, /did not announce/);

  const noisyChild = new EventEmitter();
  noisyChild.stdout = new EventEmitter();
  noisyChild.stdout.resume = () => {};
  const noisyReading = readOpencodeServerBaseUrl(noisyChild, { timeoutMs: 50 });
  queueMicrotask(() => {
    noisyChild.stdout.emit("data", Buffer.alloc(4_097, "x"));
  });
  await assert.rejects(
    noisyReading,
    /invalid address announcement/,
  );
});

test("asynchronous child spawn errors reject startup and clear owned state", async () => {
  const child = fakeChild({ exitOnKill: false });
  child.stdout = new EventEmitter();
  child.stdout.resume = () => {};
  const removedDirectories = [];
  const { lifecycle } = lifecycleHarness({
    child,
    maxStartAttempts: 1,
    readServerAddress: (ownedChild) => readOpencodeServerBaseUrl(
      ownedChild,
      { timeoutMs: 50 },
    ),
    removeConfigDirectory: async (directory) => {
      removedDirectories.push(directory);
    },
    spawnImpl: () => {
      queueMicrotask(() => {
        child.emit("error", Object.assign(
          new Error("spawn /missing/opencode ENOENT"),
          { code: "ENOENT" },
        ));
      });
      return child;
    },
  });

  await assert.rejects(
    lifecycle.start({
      command: "/missing/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /process failed|spawn failed/i,
  );
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
});

test("lifecycle timeout bounds a hanging authenticated readiness probe", async () => {
  const child = fakeChild();
  const { lifecycle } = lifecycleHarness({
    child,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    pollMs: 1,
    readinessProbeTimeoutMs: 500,
    readinessTimeoutMs: 20,
  });
  const startedAt = Date.now();

  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /did not become ready/,
  );
  assert.equal(Date.now() - startedAt < 250, true);
  assert.equal(child.killCalls, 1);
});

test("early child exit rejects startup and clears owned config state", async () => {
  const child = fakeChild();
  const { lifecycle, removedDirectories } = lifecycleHarness({
    child,
    fetchImpl: async () => response(false),
    maxStartAttempts: 1,
    sleep: async () => {
      child.exitCode = 17;
      child.emit("exit", 17, null);
    },
  });

  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /exited before becoming ready/,
  );
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
});

test("early candidate exit retries with a fresh child-owned loopback port", async () => {
  const ports = [PORT, PORT + 1];
  const configDirectories = [
    `${CONFIG_DIRECTORY}-1`,
    `${CONFIG_DIRECTORY}-2`,
  ];
  const children = [
    fakeChild({ exitOnKill: false }),
    fakeChild(),
  ];
  const removedDirectories = [];
  const spawnCalls = [];
  const exitEvents = [];
  let addressIndex = 0;
  let configIndex = 0;
  let spawnIndex = 0;
  let firstExited = false;
  const { lifecycle } = lifecycleHarness({
    createConfigDirectory: async () => configDirectories[configIndex++],
    fetchImpl: async (url, options) => {
      if (url.includes(`:${PORT}/`)) {
        if (!firstExited) {
          firstExited = true;
          children[0].exitCode = 98;
          children[0].emit("exit", 98, null);
        }
        return response(false, 503);
      }
      return response(
        options.headers.Authorization === AUTHORIZATION,
        options.headers.Authorization === AUTHORIZATION ? 200 : 401,
      );
    },
    removeConfigDirectory: async (directory) => {
      removedDirectories.push(directory);
    },
    readServerAddress: async () => (
      `http://127.0.0.1:${ports[addressIndex++]}`
    ),
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return children[spawnIndex++];
    },
  });

  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
    onExit: (event) => exitEvents.push(event),
  });

  assert.equal(handle.process, children[1]);
  assert.deepEqual(
    spawnCalls.map(({ args }) => args.at(-1)),
    ["0", "0"],
  );
  assert.equal(addressIndex, 2);
  assert.deepEqual(removedDirectories, [configDirectories[0]]);
  assert.deepEqual(exitEvents, []);
  assert.deepEqual(lifecycle.status(), { state: "running" });
});

test("early candidate exit retries only to the configured attempt bound", async () => {
  const ports = [PORT, PORT + 1];
  const children = [
    fakeChild({ exitOnKill: false }),
    fakeChild({ exitOnKill: false }),
  ];
  const removedDirectories = [];
  const spawnCalls = [];
  let addressIndex = 0;
  let spawnIndex = 0;
  const exitedPorts = new Set();
  const { lifecycle } = lifecycleHarness({
    createConfigDirectory: async () => `${CONFIG_DIRECTORY}-${addressIndex + 1}`,
    fetchImpl: async (url) => {
      const port = Number(new URL(url).port);
      if (!exitedPorts.has(port)) {
        exitedPorts.add(port);
        const child = children[ports.indexOf(port)];
        child.exitCode = 98;
        child.emit("exit", 98, null);
      }
      return response(false, 503);
    },
    maxStartAttempts: 2,
    removeConfigDirectory: async (directory) => {
      removedDirectories.push(directory);
    },
    readServerAddress: async () => (
      `http://127.0.0.1:${ports[addressIndex++]}`
    ),
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return children[spawnIndex++];
    },
  });

  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /exited before becoming ready/,
  );
  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(removedDirectories, [
    `${CONFIG_DIRECTORY}-1`,
    `${CONFIG_DIRECTORY}-2`,
  ]);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
});

test("stop is ownership-bound, idempotent, and kills only the spawned child", async () => {
  const child = fakeChild();
  const foreignChild = fakeChild();
  const { lifecycle, removedDirectories } = lifecycleHarness({ child });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  await assert.rejects(
    lifecycle.stop(Object.freeze({ process: foreignChild })),
    /not owned/,
  );
  assert.deepEqual(await lifecycle.stop(handle), { state: "stopped" });
  assert.deepEqual(await lifecycle.stop(handle), { state: "stopped" });
  assert.equal(child.killCalls, 1);
  assert.equal(foreignChild.killCalls, 0);
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
});

test("stop does not report stopped until the owned child exits", async () => {
  const child = fakeChild({ exitOnKill: false });
  const { lifecycle } = lifecycleHarness({ child });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  let stopFinished = false;
  const stopping = lifecycle.stop(handle).then((result) => {
    stopFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stopFinished, false);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.deepEqual(await stopping, { state: "stopped" });
});

test("stop escalates to SIGKILL and succeeds only after the forced exit", async () => {
  const child = fakeChild({ exitOnKill: false });
  child.kill = (signal) => {
    child.killCalls += 1;
    child.killSignals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        child.exitCode = 137;
        child.emit("exit", null, "SIGKILL");
      });
    }
    return true;
  };
  const { lifecycle, removedDirectories } = lifecycleHarness({
    child,
    terminationGraceMs: 1,
  });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  assert.deepEqual(await lifecycle.stop(handle), { state: "stopped" });
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
});

test("stop escalates and retains blocking ownership when the child will not terminate", async () => {
  const child = fakeChild({ exitOnKill: false });
  const { lifecycle, removedDirectories } = lifecycleHarness({
    child,
    terminationGraceMs: 1,
    terminationKillTimeoutMs: 1,
  });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  const outcome = await Promise.race([
    lifecycle.stop(handle).then(
      (value) => ({ kind: "resolved", value }),
      (error) => ({ error, kind: "rejected" }),
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), 50);
    }),
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.error.message, /did not terminate/i);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(lifecycle.status(), { state: "failed" });
  assert.deepEqual(removedDirectories, []);
  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /already active/,
  );

  child.exitCode = 137;
  child.emit("exit", null, "SIGKILL");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
});

test("stop surfaces a signal failure without releasing owned process authority", async () => {
  const child = fakeChild({ exitOnKill: false });
  child.kill = () => {
    throw new Error("signal denied");
  };
  const { lifecycle, removedDirectories } = lifecycleHarness({ child });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  await assert.rejects(
    lifecycle.stop(handle),
    /SIGTERM request failed/,
  );
  assert.deepEqual(lifecycle.status(), { state: "failed" });
  assert.deepEqual(removedDirectories, []);
  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /already active/,
  );

  child.exitCode = 1;
  child.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
});

test("asynchronous child errors after readiness retain ownership until real exit", async () => {
  const child = fakeChild({ exitOnKill: false });
  child.kill = (signal) => {
    child.killCalls += 1;
    child.killSignals.push(signal);
    if (signal === "SIGTERM") {
      queueMicrotask(() => {
        child.emit("error", Object.assign(
          new Error("kill EPERM"),
          { code: "EPERM" },
        ));
      });
    }
    return true;
  };
  const { lifecycle, removedDirectories } = lifecycleHarness({
    child,
    terminationGraceMs: 1,
    terminationKillTimeoutMs: 1,
  });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  await assert.rejects(
    lifecycle.stop(handle),
    /did not terminate/i,
  );
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.exitCode, null);
  assert.deepEqual(lifecycle.status(), { state: "failed" });
  assert.deepEqual(removedDirectories, []);
  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /already active/,
  );

  child.exitCode = 1;
  child.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
});

test("unexpected child exit clears private state and notifies watchers without a second kill", async () => {
  const child = fakeChild();
  const observed = [];
  const { lifecycle, removedDirectories } = lifecycleHarness({ child });
  const unwatch = lifecycle.watch((event) => observed.push(event));

  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });
  child.exitCode = 17;
  child.emit("exit", 17, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(observed, [{ state: "stopped", reason: "child-exit" }]);
  assert.deepEqual(lifecycle.status(), { state: "stopped" });
  assert.deepEqual(removedDirectories, [CONFIG_DIRECTORY]);
  assert.equal(child.killCalls, 0);
  await assert.rejects(lifecycle.createClient(handle), /not owned/);
  unwatch();
  unwatch();
});

test("stop waits for in-progress unexpected-exit cleanup before reporting stopped", async () => {
  const child = fakeChild();
  let finishCleanup;
  const cleanupStarted = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  let releaseCleanup;
  const cleanupBlocked = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const { lifecycle } = lifecycleHarness({
    child,
    removeConfigDirectory: async () => {
      finishCleanup();
      await cleanupBlocked;
    },
  });
  const handle = await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  child.exitCode = 17;
  child.emit("exit", 17, null);
  await cleanupStarted;

  let stopFinished = false;
  const stopping = lifecycle.stop(handle).then((result) => {
    stopFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopFinished, false);

  releaseCleanup();
  assert.deepEqual(await stopping, { state: "stopped" });
  assert.equal(child.killCalls, 0);
});

test("shutdown stops the active owned child and rejects concurrent lifecycle starts", async () => {
  const child = fakeChild();
  const { lifecycle } = lifecycleHarness({ child });
  await lifecycle.start({
    command: "/fixed/bin/opencode",
    cwd: WORKSPACE,
    env: {},
  });

  await assert.rejects(
    lifecycle.start({
      command: "/fixed/bin/opencode",
      cwd: WORKSPACE,
      env: {},
    }),
    /already active/,
  );
  assert.deepEqual(await lifecycle.shutdown(), { state: "stopped" });
  assert.equal(child.killCalls, 1);
});
