import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  basicAuthHeader,
  createDefaultPidRecord,
  createOpencodeHttpClient,
  ensureOpencodeServer,
  forgetOpencodeServer,
  opencodeBaseUrl,
  pickFreeLoopbackPort,
  opencodeServeBaseUrl,
  opencodeServerHealthy,
  peekOpencodeServer,
  resetOpencodeServerSingletonForTests
} from "../host/opencode-client.mjs";

const okRes = (body = "{}") => ({ ok: true, status: 200, text: async () => body });
const errRes = (status = 500, body = "nope") => ({ ok: false, status, text: async () => body });
const opencodeDoc = (paths = {}) => ({ paths });
const sessionDoc = opencodeDoc({
  "/session": { get: {}, post: {} },
  "/session/{sessionID}": { delete: {}, patch: {} },
  "/session/{sessionID}/message": { get: {}, post: {} },
  "/session/{sessionID}/prompt_async": { post: {} },
  "/session/{sessionID}/abort": { post: {} },
  "/session/{sessionID}/diff": { get: {} },
  "/session/{sessionID}/permissions/{permissionID}": { post: {} },
  "/agent": { get: {} }
});

function fakeChild(port = 45123, { announce = true, delayMs = 5 } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 0);
  };
  if (announce) {
    setTimeout(() => child.stdout.push(`opencode server listening on http://127.0.0.1:${port}\n`), delayMs);
  }
  return child;
}

const noPid = {
  read: async () => null,
  write: async () => {},
  clear: () => {},
  isAlive: () => false,
  commandOf: () => "",
  kill: () => {}
};

function authedFetch(expectedHeader, calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    return init?.headers?.Authorization === expectedHeader
      ? { ok: true, status: 200, text: async () => "{}" }
      : { ok: false, status: 401, text: async () => "" };
  };
}

function fakeProcess() {
  const processImpl = new EventEmitter();
  processImpl.exit = (code) => {
    processImpl.exitCode = code;
  };
  return processImpl;
}

const immediateSleep = async () => {};
const pickedTestPort = async () => 45123;

function ensureTestOpencodeServer(options) {
  return ensureOpencodeServer({ pickEphemeralPort: pickedTestPort, ...options });
}

function fakeNetImpl(ports) {
  const servers = [];
  return {
    servers,
    createServer: () => {
      const port = ports.shift();
      const server = new EventEmitter();
      server.closed = false;
      server.listen = (_requestedPort, _hostname, callback) => {
        server.port = port;
        queueMicrotask(callback);
        return server;
      };
      server.address = () => ({ port: server.port });
      server.close = (callback) => {
        server.closed = true;
        queueMicrotask(callback);
      };
      servers.push(server);
      return server;
    }
  };
}

test("opencodeServerHealthy is true only when the /doc probe succeeds", async () => {
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => okRes(), baseUrl: "http://x" }), true);
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => errRes(503), baseUrl: "http://x" }), false);
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => { throw new Error("conn refused"); }, baseUrl: "http://x" }), false);
});

test("pickFreeLoopbackPort skips known OpenCode defaults and returns another free port", async () => {
  const netImpl = fakeNetImpl([4096, 4231, 51000]);
  const port = await pickFreeLoopbackPort({ netImpl });
  assert.equal(port, 51000);
  assert.equal(netImpl.servers.length, 3);
  assert.deepEqual(netImpl.servers.map((server) => server.closed), [true, true, true]);
});

test("pickFreeLoopbackPort rejects when every attempt reports an avoided port", async () => {
  const netImpl = fakeNetImpl(Array.from({ length: 8 }, () => 4096));
  await assert.rejects(() => pickFreeLoopbackPort({ netImpl }), /free loopback port/);
  assert.equal(netImpl.servers.every((server) => server.closed), true);
});

test("pickFreeLoopbackPort default net implementation returns a bindable non-default loopback port", async (t) => {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("loopback listen is denied by this sandbox");
      return;
    }
    throw error;
  } finally {
    try {
      if (probe.listening) await new Promise((resolve) => probe.close(resolve));
    } catch { /* noop */ }
  }

  const port = await pickFreeLoopbackPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port >= 1024 && port <= 65535, true);
  assert.equal(port === 4096 || port === 4231, false);

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test("does not reuse a pre-existing server that answers /doc without auth (spawns, then refuses to adopt an auth-ignoring listener)", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  await assert.rejects(
    () => ensureTestOpencodeServer({
      fetchImpl: async () => okRes(),
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
      command: "/bin/opencode",
      pidRecord: noPid,
      processImpl: fakeProcess(),
      sleep: immediateSleep,
      pollMs: 1,
      maxWaitMs: 100
    }),
    /does not enforce/
  );
  assert.equal(spawns, 1);
});

test("ensureOpencodeServer spawns and waits for readiness when the server is down", async () => {
  resetOpencodeServerSingletonForTests();
  let spawned = null;
  const env = { OPENCODE_SERVER_PASSWORD: "ready-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return fakeChild();
    },
    command: "/bin/opencode",
    cwd: "/repo/root",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    pickEphemeralPort: pickedTestPort,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.ok(spawned, "spawned a server");
  assert.deepEqual(spawned.args, ["serve", "--hostname", "127.0.0.1", "--port", "45123"]);
  assert.equal(spawned.opts.cwd, "/repo/root");
  assert.equal(result.spawned, true);
  assert.equal(result.directory, "/repo/root");
});

test("ensureOpencodeServer refuses to start without a resolved command", async () => {
  resetOpencodeServerSingletonForTests();
  await assert.rejects(
    () => ensureTestOpencodeServer({
      fetchImpl: async () => errRes(503),
      command: "",
      spawnImpl: () => ({}),
      pidRecord: noPid,
      processImpl: fakeProcess()
    }),
    /not available to start/
  );
});

test("opencodeServeBaseUrl returns only a 127.0.0.1 root URL", () => {
  assert.equal(
    opencodeServeBaseUrl({ baseUrl: "http://127.0.0.1:4231/session?directory=%2Frepo" }),
    "http://127.0.0.1:4231/",
  );
  assert.equal(
    opencodeServeBaseUrl({ baseUrl: "http://localhost:4231" }),
    "http://127.0.0.1:4231/",
  );
  assert.throws(
    () => opencodeServeBaseUrl({ baseUrl: "http://192.168.1.2:4231" }),
    /loopback literal/,
  );
});

test("ensureOpencodeServer uses default serve args and piped stdout", async () => {
  resetOpencodeServerSingletonForTests();
  let spawned = null;
  const env = { OPENCODE_SERVER_PASSWORD: "default-secret" };
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    pickEphemeralPort: pickedTestPort,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.deepEqual(spawned.args, ["serve", "--hostname", "127.0.0.1", "--port", "45123"]);
  assert.deepEqual(spawned.opts.stdio, ["ignore", "pipe", "ignore"]);
});

test("ensureOpencodeServer mints unique default child passwords", async () => {
  const passwords = [];
  const run = async () => {
    resetOpencodeServerSingletonForTests();
    await ensureTestOpencodeServer({
      fetchImpl: async (_url, init = {}) => (
        init?.headers?.Authorization === basicAuthHeader("opencode", passwords.at(-1)) ? okRes() : errRes(401)
      ),
      spawnImpl: (_cmd, _args, opts) => {
        passwords.push(opts.env.OPENCODE_SERVER_PASSWORD);
        assert.equal(opts.env.OPENCODE_SERVER_USERNAME, "opencode");
        assert.ok(opts.env.OPENCODE_SERVER_PASSWORD.length >= 43);
        return fakeChild();
      },
      command: "/bin/opencode",
      env: {},
      pidRecord: noPid,
      processImpl: fakeProcess(),
      sleep: immediateSleep,
      pollMs: 1,
      maxWaitMs: 100
    });
  };

  await run();
  await run();
  assert.notEqual(passwords[0], passwords[1]);
});

test("ensureOpencodeServer returns the base URL from the announcement", async () => {
  resetOpencodeServerSingletonForTests();
  const env = { OPENCODE_SERVER_PASSWORD: "announce-secret" };
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(result.baseUrl, "http://127.0.0.1:45123");
});

test("readiness probes with the header first, then confirms a no-header request is rejected", async () => {
  resetOpencodeServerSingletonForTests();
  const calls = [];
  const env = { OPENCODE_SERVER_PASSWORD: "probe-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, calls),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.ok(calls.length > 1);
  assert.equal(calls.every((call) => call.auth === expectedHeader || call.auth === null), true);
  // exactly one deliberate no-header enforcement check, and only after an authed 200
  assert.equal(calls.filter((call) => call.auth === null).length, 1);
  assert.equal(calls.findIndex((call) => call.auth === null) > calls.findIndex((call) => call.auth === expectedHeader), true);
});

test("refuses to adopt a listener that answers 200 without the credential", async () => {
  resetOpencodeServerSingletonForTests();
  const child = fakeChild();
  await assert.rejects(
    () => ensureTestOpencodeServer({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      spawnImpl: () => child,
      command: "/bin/opencode",
      env: { RESONANTOS_OPENCODE_PORT: "45123" },
      pidRecord: noPid,
      processImpl: fakeProcess(),
      sleep: immediateSleep,
      pollMs: 1,
      maxWaitMs: 100
    }),
    /does not enforce/
  );
  assert.equal(child.killed, true);
});

test("fails closed if the child exits before becoming ready", async () => {
  resetOpencodeServerSingletonForTests();
  const child = fakeChild(45123, { announce: false });
  setTimeout(() => child.emit("exit", 1), 5);
  await assert.rejects(
    () => ensureTestOpencodeServer({
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => "" }),
      spawnImpl: () => child,
      command: "/bin/opencode",
      env: {},
      pidRecord: noPid,
      processImpl: fakeProcess(),
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      pollMs: 5,
      maxWaitMs: 400
    }),
    /exited before/
  );
});

test("a stale child's late exit does not clear the newer server's pid record", async () => {
  resetOpencodeServerSingletonForTests();
  const ops = [];
  let spawns = 0;
  const children = [];
  const pid = { read: async () => null, write: async (_d, rec) => { ops.push(["write", rec.pid]); }, clear: () => { ops.push(["clear"]); }, isAlive: () => false, commandOf: () => "", kill: () => {} };
  const env = { OPENCODE_SERVER_PASSWORD: "pid-late-exit-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const base = { command: "/bin/opencode", env, pidRecord: pid, processImpl: fakeProcess(), sleep: immediateSleep, pollMs: 1, maxWaitMs: 100,
    fetchImpl: authedFetch(expectedHeader, []), spawnImpl: () => { spawns += 1; const c = fakeChild(45123 + spawns); c.pid = 5000 + spawns; children.push(c); return c; } };
  const first = await ensureTestOpencodeServer(base);
  forgetOpencodeServer(first);
  await ensureTestOpencodeServer(base);
  const before = ops.length;
  children[0].emit("exit", 0); // stale child exits late
  assert.deepEqual(ops.slice(before), []); // must not clear the newer server's record
  assert.deepEqual(ops[ops.length - 1], ["write", 5002]);
});

test("a stale child's late exit does not clobber the newer singleton entry", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const children = [];
  const env = { OPENCODE_SERVER_PASSWORD: "late-exit-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const base = { command: "/bin/opencode", env, pidRecord: noPid, processImpl: fakeProcess(), sleep: immediateSleep, pollMs: 1, maxWaitMs: 100,
    fetchImpl: authedFetch(expectedHeader, []), spawnImpl: () => { spawns += 1; const c = fakeChild(45123 + spawns); children.push(c); return c; } };
  const first = await ensureTestOpencodeServer(base);
  forgetOpencodeServer(first);
  const second = await ensureTestOpencodeServer(base);
  assert.equal(spawns, 2);
  children[0].emit("exit", 0); // stale child exits late
  const third = await ensureTestOpencodeServer(base);
  assert.equal(spawns, 2);
  assert.equal(third.baseUrl, second.baseUrl);
  assert.equal(third.spawned, false);
});

test("a reused singleton must still reject no-header requests", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "reuse-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const base = { spawnImpl: () => { spawns += 1; return fakeChild(); }, command: "/bin/opencode", env, pidRecord: noPid, processImpl: fakeProcess(), sleep: immediateSleep, pollMs: 1, maxWaitMs: 100 };
  await ensureTestOpencodeServer({ ...base, fetchImpl: authedFetch(expectedHeader, []) });
  // the server behind the singleton now ignores auth (e.g. replaced by a foreign listener)
  await assert.rejects(
    () => ensureTestOpencodeServer({ ...base, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) }),
    /does not enforce/
  );
  assert.equal(spawns, 2);
});

test("ensureOpencodeServer exposes operator-provided auth metadata", async () => {
  resetOpencodeServerSingletonForTests();
  const env = { OPENCODE_SERVER_PASSWORD: "operator-known-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(result.auth.header, expectedHeader);
  assert.equal(result.auth.username, "opencode");
});

test("concurrent ensureOpencodeServer calls share one spawn", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "concurrent-secret" };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => {
      spawns += 1;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const results = await Promise.all([ensure(), ensure()]);
  assert.equal(spawns, 1);
  assert.equal(results[0].baseUrl, results[1].baseUrl);
});

test("sequential ensureOpencodeServer reuses the singleton until reset", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "reuse-secret" };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => {
      spawns += 1;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const first = await ensure();
  const second = await ensure();
  assert.equal(first.spawned, true);
  assert.equal(second.spawned, false);
  assert.equal(spawns, 1);

  resetOpencodeServerSingletonForTests();
  await ensure();
  assert.equal(spawns, 2);
});

test("stale singleton health failure starts a fresh server", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  let rejectOld = false;
  const env = { OPENCODE_SERVER_PASSWORD: "stale-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const fetchImpl = async (_url, init = {}) => {
    if (init?.headers?.Authorization !== expectedHeader) return errRes(401);
    if (rejectOld && spawns === 1) return errRes(401);
    return okRes();
  };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl,
    spawnImpl: () => {
      spawns += 1;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  await ensure();
  rejectOld = true;
  await ensure();
  assert.equal(spawns, 2);
});

test("forgetOpencodeServer makes the next ensure spawn again", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "forget-secret" };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => {
      spawns += 1;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const result = await ensure();
  forgetOpencodeServer(result);
  await ensure();
  assert.equal(spawns, 2);
});

test("child exit clears the opencode singleton", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "exit-secret" };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => {
      spawns += 1;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const result = await ensure();
  result.process.emit("exit", 0);
  await ensure();
  assert.equal(spawns, 2);
});

test("ensureOpencodeServer rejects and kills when an unannounced picked port never becomes ready", async () => {
  resetOpencodeServerSingletonForTests();
  const child = fakeChild(45123, { announce: false });
  await assert.rejects(
    () => ensureTestOpencodeServer({
      fetchImpl: async () => errRes(401),
      spawnImpl: () => child,
      command: "/bin/opencode",
      env: {},
      pidRecord: noPid,
      processImpl: fakeProcess(),
      pickEphemeralPort: pickedTestPort,
      sleep: immediateSleep,
      pollMs: 1,
      maxWaitMs: 20
    }),
    /did not become ready/
  );
  assert.equal(child.killed, true);
});

test("ensureOpencodeServer falls back to the picked port when no announcement arrives but readiness succeeds", async () => {
  resetOpencodeServerSingletonForTests();
  const child = fakeChild(45123, { announce: false });
  const env = { OPENCODE_SERVER_PASSWORD: "fallback-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const result = await ensureTestOpencodeServer({
    fetchImpl: async (url, init = {}) => (
      String(url) === "http://127.0.0.1:45123/doc" && init?.headers?.Authorization === expectedHeader
        ? okRes()
        : errRes(401)
    ),
    spawnImpl: () => child,
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    pickEphemeralPort: pickedTestPort,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 20
  });
  assert.equal(result.baseUrl, "http://127.0.0.1:45123");
  assert.equal(child.killed, false);
});

test("RESONANTOS_OPENCODE_PORT controls serve args and fallback base URL without picking an ephemeral port", async () => {
  resetOpencodeServerSingletonForTests();
  const calls = [];
  let spawned = null;
  const env = { RESONANTOS_OPENCODE_PORT: "4231", OPENCODE_SERVER_PASSWORD: "env-port-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, calls),
    spawnImpl: (cmd, args, opts) => {
      spawned = { cmd, args, opts };
      return fakeChild(45123, { announce: false });
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    pickEphemeralPort: async () => {
      throw new Error("explicit ports must not pick an ephemeral port");
    },
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 20
  });
  assert.deepEqual(spawned.args.slice(-2), ["--port", "4231"]);
  // authed probes plus exactly one deliberate no-header enforcement check
  assert.equal(calls.every((call) => call.auth === expectedHeader || call.auth === null), true);
  assert.equal(calls.filter((call) => call.auth === null).length, 1);
  assert.equal(result.baseUrl, "http://127.0.0.1:4231");
});

test("operator password is passed only through child env and derives the header", async () => {
  resetOpencodeServerSingletonForTests();
  let childEnv = null;
  const env = { OPENCODE_SERVER_PASSWORD: "operator-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: (_cmd, _args, opts) => {
      childEnv = opts.env;
      return fakeChild();
    },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(childEnv.OPENCODE_SERVER_PASSWORD, "operator-secret");
  assert.equal(result.auth.header, expectedHeader);
});

test("stdout keeps draining after the listening announcement", async () => {
  resetOpencodeServerSingletonForTests();
  const child = fakeChild();
  const env = { OPENCODE_SERVER_PASSWORD: "drain-secret" };
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => child,
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.ok(child.stdout.listenerCount("data") >= 1);
  assert.equal(child.stdout.readableFlowing, true);
  child.stdout.push("x".repeat(70_000));
  await new Promise((resolve) => setImmediate(resolve));
});

test("shutdown hooks kill children and install only once", async () => {
  resetOpencodeServerSingletonForTests();
  const processImpl = fakeProcess();
  const child = fakeChild();
  const env = { OPENCODE_SERVER_PASSWORD: "hook-secret" };
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => child,
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  await ensure();
  await ensure();
  assert.equal(processImpl.listenerCount("SIGTERM"), 1);
  processImpl.emit("exit");
  assert.equal(child.killed, true);
});

test("SIGTERM shutdown kills children and synchronously clears pid records this process wrote", async () => {
  resetOpencodeServerSingletonForTests();
  const processImpl = fakeProcess();
  processImpl.pid = 777;
  const child = fakeChild();
  const clears = [];
  const writes = [];
  const env = { OPENCODE_SERVER_PASSWORD: "signal-clear-secret" };
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => child,
    command: "/bin/opencode",
    cwd: "/repo/root",
    env,
    pidRecord: {
      read: async () => null,
      write: async (directory, rec) => { writes.push({ directory, rec }); },
      clear: (directory) => { clears.push(directory); },
      isAlive: () => false,
      commandOf: () => "",
      kill: () => {}
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(writes.length, 1);
  processImpl.emit("SIGTERM");
  assert.equal(child.killed, true);
  assert.deepEqual(clears, ["/repo/root"]);
  assert.equal(processImpl.exitCode, 143);
});

test("SIGTERM shutdown does not clear pid records written by another owner", async () => {
  resetOpencodeServerSingletonForTests();
  const processImpl = fakeProcess();
  processImpl.pid = 777;
  const child = fakeChild();
  const clears = [];
  const env = { OPENCODE_SERVER_PASSWORD: "foreign-signal-secret" };
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => child,
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => ({ owner: 888, pid: 999, port: 45123, startedAt: 0 }),
      write: async () => {},
      clear: (directory) => { clears.push(directory); },
      isAlive: (pid) => pid === 888,
      commandOf: () => "/x/opencode-ai/bin/opencode serve --port 45123",
      kill: () => {}
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  processImpl.emit("SIGTERM");
  assert.equal(child.killed, true);
  assert.deepEqual(clears, []);
});

test("pidRecord cleans stale opencode serve processes and records the new child", async () => {
  const writes = [];
  const killed = [];
  const run = async (commandOf) => {
    resetOpencodeServerSingletonForTests();
    const env = { OPENCODE_SERVER_PASSWORD: `pid-secret-${writes.length}` };
    await ensureTestOpencodeServer({
      fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
      spawnImpl: () => fakeChild(),
      command: "/bin/opencode",
      env,
      pidRecord: {
        read: async () => ({ pid: 999 }),
        write: async (_directory, rec) => {
          writes.push(rec);
        },
        clear: () => {},
        isAlive: () => true,
        commandOf: () => commandOf,
        kill: (pid) => {
          killed.push(pid);
        }
      },
      processImpl: fakeProcess(),
      sleep: immediateSleep,
      pollMs: 1,
      maxWaitMs: 100
    });
  };

  await run("opencode serve --port 0");
  await run("node something");
  assert.deepEqual(killed, [999]);
  assert.equal(writes[0].pid, 4242);
  assert.equal(writes[0].port, 45123);
  assert.equal(writes[1].pid, 4242);
  assert.equal(writes[1].port, 45123);
});

test("startup clears a stale pid record whose child pid is already dead", async () => {
  resetOpencodeServerSingletonForTests();
  const clears = [];
  const writes = [];
  const env = { OPENCODE_SERVER_PASSWORD: "dead-record-secret" };
  const processImpl = fakeProcess();
  processImpl.pid = 777;
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    cwd: "/repo/root",
    env,
    pidRecord: {
      read: async () => ({ owner: 888, pid: 999, port: 45123, startedAt: 0 }),
      write: async (_directory, rec) => { writes.push(rec); },
      clear: (directory) => { clears.push(directory); },
      isAlive: () => false,
      commandOf: () => "",
      kill: () => {}
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.deepEqual(clears, ["/repo/root"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].owner, 777);
});

test("base URL helpers strip auth and require explicit positive ports", () => {
  assert.equal(
    opencodeServeBaseUrl({ baseUrl: "http://127.0.0.1:60523", auth: { username: "opencode", password: "pw" } }),
    "http://127.0.0.1:60523/"
  );
  assert.equal(
    opencodeServeBaseUrl({ baseUrl: "http://a:b@127.0.0.1:60523/x" }),
    "http://127.0.0.1:60523/"
  );
  assert.equal(opencodeBaseUrl({ hostname: "127.0.0.1", port: 45123 }), "http://127.0.0.1:45123");
  assert.throws(() => opencodeBaseUrl({}), /positive integer port/);
  assert.throws(() => opencodeBaseUrl({ port: 0 }), /positive integer port/);
});

test("createDefaultPidRecord stores state under the user root and can round-trip", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-pid-"));
  try {
    const record = createDefaultPidRecord({ RESONANTOS_BROWSER_FIRST_USER_ROOT: root });
    assert.equal(record.path.startsWith(root), true);
    assert.equal(record.path.endsWith(join("BrowserFirst", "opencode-server.json")), true);
    await record.write("/repo/root", { pid: 123, port: 456 });
    assert.deepEqual(await record.read("/repo/root"), { pid: 123, port: 456 });
    await record.clear("/repo/root");
    assert.equal(await record.read("/repo/root"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secrets are not present in safe serialized server info or module logging", async () => {
  resetOpencodeServerSingletonForTests();
  const env = { OPENCODE_SERVER_PASSWORD: "very-secret-password" };
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(JSON.stringify({ baseUrl: result.baseUrl, directory: result.directory, spawned: result.spawned }).includes(env.OPENCODE_SERVER_PASSWORD), false);
  const source = readFileSync(new URL("../host/opencode-client.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("console."), false);
});

test("module source does not contain removed default port literals", () => {
  const source = readFileSync(new URL("../host/opencode-client.mjs", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.includes("port-literal-allowlist")).join("\n");
  assert.equal(/\b(4096|4231)\b/.test(source), false);
});

test("the http client uses OpenAPI-derived async prompt and exact permission shape", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/session")) return okRes(JSON.stringify({ id: "s1" }));
    return okRes("{}");
  };
  const client = createOpencodeHttpClient({
    fetchImpl,
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    apiDoc: sessionDoc
  });

  const session = await client.createSession("test");
  assert.equal(session.id, "s1");

  await client.prompt("s1", "run tests", { agent: "build" });
  await client.replyPermission("s1", "p1", { approved: true, remember: true });

  assert.deepEqual(calls[0], { url: "http://127.0.0.1:4096/session", method: "POST", body: { title: "test" } });
  assert.deepEqual(calls[1], {
    url: "http://127.0.0.1:4096/session/s1/prompt_async",
    method: "POST",
    body: { parts: [{ type: "text", text: "run tests" }], agent: "build" }
  });
  assert.deepEqual(calls[2], {
    url: "http://127.0.0.1:4096/session/s1/permissions/p1",
    method: "POST",
    body: { response: "always" }
  });
});

test("the http client converts provider/model picker values into the OpenCode model object", async () => {
  const calls = [];
  const client = createOpencodeHttpClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return okRes("{}");
    },
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    apiDoc: sessionDoc
  });

  await client.prompt("s1", "use structured model", { model: "anthropic/claude-sonnet-4.5", agent: "build" });
  await client.prompt("s1", "drop malformed model", { model: "claude-sonnet-4.5", agent: "build" });

  assert.deepEqual(calls[0], {
    url: "http://127.0.0.1:4096/session/s1/prompt_async",
    method: "POST",
    body: {
      parts: [{ type: "text", text: "use structured model" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4.5" },
      agent: "build"
    }
  });
  assert.deepEqual(calls[1], {
    url: "http://127.0.0.1:4096/session/s1/prompt_async",
    method: "POST",
    body: { parts: [{ type: "text", text: "drop malformed model" }], agent: "build" }
  });
});

test("the http client falls back to sync prompt when prompt_async is absent from the doc", async () => {
  const calls = [];
  const client = createOpencodeHttpClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return okRes("{}");
    },
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    apiDoc: opencodeDoc({ "/session/{sessionID}/message": { post: {} } })
  });
  await client.prompt("s1", "sync fallback");
  assert.deepEqual(calls[0], {
    url: "http://127.0.0.1:4096/session/s1/message",
    method: "POST",
    body: { parts: [{ type: "text", text: "sync fallback" }] }
  });
});

test("the http client shapes parity endpoints and pins directory query params", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes("/agent")) return okRes(JSON.stringify([{ name: "build" }]));
    if (url.includes("/diff")) return okRes(JSON.stringify([{ path: "a.txt", hunks: [] }]));
    return okRes("{}");
  };
  const client = createOpencodeHttpClient({
    fetchImpl,
    baseUrl: "http://127.0.0.1:4096",
    directory: "/repo/root",
    apiDoc: sessionDoc
  });

  await client.createSession("Pinned");
  await client.listSessions();
  await client.messages("ses_1");
  await client.sessionDiff("ses_1");
  await client.abort("ses_1");
  await client.rename("ses_1", "Renamed");
  await client.remove("ses_1");
  await client.archive("ses_1", 12345);
  await client.listAgents();

  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:4096/session?directory=%2Frepo%2Froot", method: "POST", body: { title: "Pinned" } },
    { url: "http://127.0.0.1:4096/session?directory=%2Frepo%2Froot", method: "GET", body: null },
    { url: "http://127.0.0.1:4096/session/ses_1/message?directory=%2Frepo%2Froot", method: "GET", body: null },
    { url: "http://127.0.0.1:4096/session/ses_1/diff?directory=%2Frepo%2Froot", method: "GET", body: null },
    { url: "http://127.0.0.1:4096/session/ses_1/abort?directory=%2Frepo%2Froot", method: "POST", body: null },
    { url: "http://127.0.0.1:4096/session/ses_1?directory=%2Frepo%2Froot", method: "PATCH", body: { title: "Renamed" } },
    { url: "http://127.0.0.1:4096/session/ses_1?directory=%2Frepo%2Froot", method: "DELETE", body: null },
    { url: "http://127.0.0.1:4096/session/ses_1?directory=%2Frepo%2Froot", method: "PATCH", body: { time: { archived: 12345 } } },
    { url: "http://127.0.0.1:4096/agent?directory=%2Frepo%2Froot", method: "GET", body: null }
  ]);
});

test("the http client rejects on a non-ok response", async () => {
  const client = createOpencodeHttpClient({ fetchImpl: async () => errRes(500, "boom"), baseUrl: "http://x", directory: "" });
  await assert.rejects(() => client.createSession(), /failed: 500/);
});

test("management calls use a 20s AbortController timeout and name the timed out call", async () => {
  const client = createOpencodeHttpClient({
    fetchImpl: async (_url, init = {}) => {
      if (!init.signal) throw new Error("missing abort signal");
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    requestTimeoutMs: 1
  });

  await assert.rejects(() => client.listSessions(), /opencode listSessions timed out after 1ms/);
});

test("prompt_async uses the management timeout while sync prompt fallback gets ten minutes", async () => {
  const timers = [];
  const clientAsync = createOpencodeHttpClient({
    fetchImpl: async () => okRes("{}"),
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    apiDoc: sessionDoc,
    setTimeoutImpl: (fn, ms) => {
      timers.push(ms);
      return { fn, ms };
    },
    clearTimeoutImpl: () => {}
  });
  await clientAsync.prompt("s1", "fast");

  const clientFallback = createOpencodeHttpClient({
    fetchImpl: async () => okRes("{}"),
    baseUrl: "http://127.0.0.1:4096",
    directory: "",
    apiDoc: opencodeDoc({ "/session/{sessionID}/message": { post: {} } }),
    setTimeoutImpl: (fn, ms) => {
      timers.push(ms);
      return { fn, ms };
    },
    clearTimeoutImpl: () => {}
  });
  await clientFallback.prompt("s1", "slow");

  assert.deepEqual(timers, [20_000, 600_000]);
});

test("failed API doc loads are retried so prompt_async is used after a later successful doc fetch", async () => {
  const calls = [];
  let docCalls = 0;
  const client = createOpencodeHttpClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      if (url.endsWith("/doc")) {
        docCalls += 1;
        return docCalls === 1 ? errRes(503, "not ready") : okRes(JSON.stringify(sessionDoc));
      }
      return okRes("{}");
    },
    baseUrl: "http://127.0.0.1:4096",
    directory: ""
  });

  await client.prompt("s1", "first");
  await client.prompt("s1", "second");

  assert.equal(docCalls, 2);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:4096/doc",
    "http://127.0.0.1:4096/session/s1/message",
    "http://127.0.0.1:4096/doc",
    "http://127.0.0.1:4096/session/s1/prompt_async"
  ]);
});

test("concurrent first API doc callers share one in-flight fetch before using prompt_async", async () => {
  let resolveDoc;
  let docCalls = 0;
  const promptUrls = [];
  const docPromise = new Promise((resolve) => { resolveDoc = resolve; });
  const client = createOpencodeHttpClient({
    fetchImpl: async (url) => {
      if (url.endsWith("/doc")) {
        docCalls += 1;
        await docPromise;
        return okRes(JSON.stringify(sessionDoc));
      }
      promptUrls.push(url);
      return okRes("{}");
    },
    baseUrl: "http://127.0.0.1:4096",
    directory: ""
  });

  const first = client.prompt("s1", "one");
  const second = client.prompt("s1", "two");
  await Promise.resolve();
  assert.equal(docCalls, 1);
  resolveDoc();
  await Promise.all([first, second]);

  assert.deepEqual(promptUrls, [
    "http://127.0.0.1:4096/session/s1/prompt_async",
    "http://127.0.0.1:4096/session/s1/prompt_async"
  ]);
});

test("the reaper matches the opencode.exe serve wrapper on the full command line", async () => {
  resetOpencodeServerSingletonForTests();
  const killed = [];
  const env = { OPENCODE_SERVER_PASSWORD: "exe-wrapper-secret" };
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => ({ pid: 999 }),
      write: async () => {},
      clear: () => {},
      isAlive: () => true,
      commandOf: () => "/x/opencode-ai/bin/opencode.exe serve --hostname 127.0.0.1 --port 57979",
      kill: (pid) => { killed.push(pid); }
    },
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.deepEqual(killed, [999]);
});

test("a pid record owned by a live other process is never killed or overwritten, and our server still starts", async () => {
  resetOpencodeServerSingletonForTests();
  const killed = [];
  const writes = [];
  const env = { OPENCODE_SERVER_PASSWORD: "foreign-owner-secret" };
  const processImpl = fakeProcess();
  processImpl.pid = 777;
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => ({ owner: 888, pid: 999, port: 45123, startedAt: 0 }),
      write: async (_directory, rec) => { writes.push(rec); },
      clear: () => {},
      isAlive: () => true,
      commandOf: () => "/x/opencode-ai/bin/opencode serve --port 0",
      kill: (pid) => { killed.push(pid); }
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(result.spawned, true);
  assert.equal(result.baseUrl, "http://127.0.0.1:45123");
  assert.deepEqual(killed, []);
  assert.deepEqual(writes, []);
});

test("a pid record owned by a dead process with a matching serve command is killed and overwritten", async () => {
  resetOpencodeServerSingletonForTests();
  const killed = [];
  const writes = [];
  const env = { OPENCODE_SERVER_PASSWORD: "dead-owner-secret" };
  const processImpl = fakeProcess();
  processImpl.pid = 777;
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD), []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => ({ owner: 888, pid: 999, port: 45123, startedAt: 0 }),
      write: async (_directory, rec) => { writes.push(rec); },
      clear: () => {},
      isAlive: (pid) => pid === 999,
      commandOf: () => "/x/opencode-ai/bin/opencode.exe serve --hostname 127.0.0.1 --port 57979",
      kill: (pid) => { killed.push(pid); }
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  assert.equal(result.spawned, true);
  assert.deepEqual(killed, [999]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].owner, 777);
  assert.equal(writes[0].pid, 4242);
});

test("child exit clears the pid record only when this process owns it", async () => {
  const env = { OPENCODE_SERVER_PASSWORD: "owner-exit-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const processImpl = fakeProcess();
  processImpl.pid = 777;

  // owner matches this process -> cleared
  resetOpencodeServerSingletonForTests();
  let clears = 0;
  let ownerReads = 0;
  const child = fakeChild();
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: () => child,
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => {
        ownerReads += 1;
        return ownerReads === 1 ? null : { owner: 777, pid: child.pid };
      },
      write: async () => {},
      clear: () => { clears += 1; },
      isAlive: () => false,
      commandOf: () => "",
      kill: () => {}
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  child.emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clears, 1);

  // owner differs -> left alone
  resetOpencodeServerSingletonForTests();
  clears = 0;
  let foreignReads = 0;
  const otherChild = fakeChild();
  await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: () => otherChild,
    command: "/bin/opencode",
    env,
    pidRecord: {
      read: async () => {
        foreignReads += 1;
        return foreignReads === 1 ? null : { owner: 888, pid: otherChild.pid };
      },
      write: async () => {},
      clear: () => { clears += 1; },
      isAlive: () => false,
      commandOf: () => "",
      kill: () => {}
    },
    processImpl,
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  otherChild.emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clears, 0);
});

test("a registered singleton missing auth is treated as unhealthy and respawns", async () => {
  resetOpencodeServerSingletonForTests();
  let spawns = 0;
  const env = { OPENCODE_SERVER_PASSWORD: "missing-auth-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  const ensure = () => ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: () => { spawns += 1; return fakeChild(45123 + spawns); },
    command: "/bin/opencode",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const first = await ensure();
  assert.equal(spawns, 1);
  first.auth = undefined; // simulate a singleton entry with no auth metadata
  const second = await ensure();
  assert.equal(spawns, 2);
  assert.equal(second.spawned, true);
});

test("peekOpencodeServer returns the registered singleton without spawning, or null", async () => {
  resetOpencodeServerSingletonForTests();
  const env = { OPENCODE_SERVER_PASSWORD: "peek-secret" };
  const expectedHeader = basicAuthHeader("opencode", env.OPENCODE_SERVER_PASSWORD);
  assert.equal(peekOpencodeServer({ command: "/bin/opencode", hostname: "127.0.0.1", cwd: "/repo/root", env }), null);
  const result = await ensureTestOpencodeServer({
    fetchImpl: authedFetch(expectedHeader, []),
    spawnImpl: () => fakeChild(),
    command: "/bin/opencode",
    hostname: "127.0.0.1",
    cwd: "/repo/root",
    env,
    pidRecord: noPid,
    processImpl: fakeProcess(),
    sleep: immediateSleep,
    pollMs: 1,
    maxWaitMs: 100
  });
  const peeked = peekOpencodeServer({ command: "/bin/opencode", hostname: "127.0.0.1", cwd: "/repo/root", env });
  assert.equal(peeked?.baseUrl, result.baseUrl);
  assert.equal(peeked?.spawned, true);
});
