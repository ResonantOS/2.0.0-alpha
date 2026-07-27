import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpencodeHttpClient,
  ensureOpencodeServer,
  opencodeServerHealthy
} from "../host/opencode-client.mjs";

const okRes = (body = "{}") => ({ ok: true, status: 200, text: async () => body });
const errRes = (status = 500, body = "nope") => ({ ok: false, status, text: async () => body });

test("opencodeServerHealthy is true only when the /doc probe succeeds", async () => {
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => okRes(), baseUrl: "http://x" }), true);
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => errRes(503), baseUrl: "http://x" }), false);
  assert.equal(await opencodeServerHealthy({ fetchImpl: async () => { throw new Error("conn refused"); }, baseUrl: "http://x" }), false);
});

test("ensureOpencodeServer reuses a healthy server and does not spawn", async () => {
  let spawns = 0;
  const result = await ensureOpencodeServer({
    fetchImpl: async () => okRes(),
    spawnImpl: () => { spawns += 1; return { kill() {} }; },
    command: "/bin/opencode"
  });
  assert.equal(spawns, 0);
  assert.equal(result.spawned, false);
  assert.match(result.baseUrl, /^http:\/\/127\.0\.0\.1:4096$/);
});

test("ensureOpencodeServer spawns and waits for readiness when the server is down", async () => {
  let health = 0;
  let spawned = null;
  const result = await ensureOpencodeServer({
    // First probe (pre-spawn) fails; after spawn it becomes healthy on the 2nd poll.
    fetchImpl: async () => (++health >= 3 ? okRes() : errRes(503)),
    spawnImpl: (cmd, args) => { spawned = { cmd, args }; return { kill() {} }; },
    command: "/bin/opencode",
    sleep: async () => {},
    pollMs: 1,
    maxWaitMs: 1000
  });
  assert.ok(spawned, "spawned a server");
  assert.deepEqual(spawned.args, ["serve", "--hostname", "127.0.0.1", "--port", "4096"]);
  assert.equal(result.spawned, true);
});

test("ensureOpencodeServer refuses to start without a resolved command", async () => {
  await assert.rejects(
    () => ensureOpencodeServer({ fetchImpl: async () => errRes(503), command: "", spawnImpl: () => ({}) }),
    /not available to start/
  );
});

test("the http client shapes session/prompt/permission calls correctly", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/session")) return okRes(JSON.stringify({ id: "s1" }));
    return okRes("{}");
  };
  const client = createOpencodeHttpClient({ fetchImpl, baseUrl: "http://127.0.0.1:4096" });

  const session = await client.createSession("test");
  assert.equal(session.id, "s1");

  await client.prompt("s1", "run tests", { agent: "build" });
  await client.replyPermission("s1", "p1", { approved: true, remember: true });

  assert.deepEqual(calls[0], { url: "http://127.0.0.1:4096/session", method: "POST", body: { title: "test" } });
  assert.deepEqual(calls[1], {
    url: "http://127.0.0.1:4096/session/s1/message",
    method: "POST",
    body: { parts: [{ type: "text", text: "run tests" }], agent: "build" }
  });
  assert.deepEqual(calls[2], {
    url: "http://127.0.0.1:4096/session/s1/permissions/p1",
    method: "POST",
    body: { response: true, remember: true }
  });
});

test("the http client rejects on a non-ok response", async () => {
  const client = createOpencodeHttpClient({ fetchImpl: async () => errRes(500, "boom"), baseUrl: "http://x" });
  await assert.rejects(() => client.createSession(), /failed: 500/);
});
