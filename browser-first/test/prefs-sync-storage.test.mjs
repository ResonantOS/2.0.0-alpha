import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createPrefsSync } from "../resonantos-side-panel-extension/src/lib/prefs-sync.js";
import { renderBridgeTargetSection } from "../resonantos-side-panel-extension/src/lib/settings/bridge-target-section.js";

function fixture(t, storage, remote = { augmentorModel: "remote-model" }) {
  const posts = [];
  const sync = createPrefsSync({ storage, bridgeRequest: async (_, options) => {
    if (options.method === "POST") { posts.push(options.body.prefs); return { ok: true }; }
    return { prefs: remote, source: "stored" };
  } });
  t.after(() => sync.teardown());
  return { sync, posts };
}

test("failed local push read preserves remote preferences and explicit retry recovers", async (t) => {
  let fail = true;
  const { sync, posts } = fixture(t, { get: async () => {
    if (fail) throw new Error("fixture read failure");
    return { augmentorModel: "local-model" };
  } });
  await sync.flush();
  assert.equal(posts.length, 0);
  assert.match(sync.getState().lastError, /fixture read failure/);
  assert.equal(sync.getState().lastPushAt, 0);
  fail = false;
  await sync.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].augmentorModel, "local-model");
  assert.equal(sync.getState().lastError, null);
});

test("failed local pull read performs no writes or push", async (t) => {
  let writes = 0;
  const { sync, posts } = fixture(t, { get: async () => { throw new Error("read unavailable"); }, set: async () => { writes++; } });
  const result = await sync.hydrate();
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
  assert.equal(posts.length, 0);
  assert.equal(sync.getState().pending, false);
});

test("failed pull write cannot claim application and blocks pushes until a successful pull", async (t) => {
  let fail = true;
  const local = {};
  const { sync, posts } = fixture(t, { get: async () => ({ ...local }), set: async (values) => {
    if (fail) throw new Error("fixture write failure");
    Object.assign(local, values);
  } });
  const result = await sync.hydrate();
  assert.equal(result.ok, false);
  assert.notEqual(result.wroteAny, true);
  assert.equal(sync.getState().lastPullAt, 0);
  await sync.flush();
  assert.equal(posts.length, 0);
  assert.match(sync.getState().lastError, /Pull from bridge again/);
  fail = false;
  assert.equal((await sync.hydrate()).ok, true);
  await sync.flush();
  assert.equal(posts[0].augmentorModel, "remote-model");
  assert.equal(sync.getState().lastError, null);
});

test("queued push cannot publish a partially applied failed pull", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const local = {};
  const { sync, posts } = fixture(t, { get: async () => ({ ...local }), set: async (values) => {
    local.augmentorModel = values.augmentorModel;
    entered();
    await gate;
    throw new Error("partial write failure");
  } }, { augmentorModel: "remote-model", augmentorThinkingDepth: "deep" });
  const pull = sync.hydrate();
  await started;
  const push = sync.flush();
  release();
  assert.equal((await pull).ok, false);
  await push;
  assert.equal(posts.length, 0);
});

test("missing or malformed storage is not treated as an empty snapshot", async (t) => {
  for (const storage of [{}, { get: async () => null }, { get: async () => [] }]) {
    const { sync, posts } = fixture(t, storage);
    await sync.flush();
    assert.equal(posts.length, 0);
    assert.ok(sync.getState().lastError);
  }
});

test("new profile pull applies remote values and an empty remote does not auto-push", async (t) => {
  const local = {};
  const { sync } = fixture(t, { get: async () => ({ ...local }), set: async (values) => Object.assign(local, values) });
  assert.equal((await sync.hydrate()).wroteAny, true);
  assert.equal(local.augmentorModel, "remote-model");
  const empty = fixture(t, { get: async () => ({}) }, {});
  assert.deepEqual(await empty.sync.hydrate(), { ok: true, source: "stored", wroteAny: false });
  assert.equal(empty.sync.getState().pending, false);
});

test("push waits for a successful pull to finish applying all values", async (t) => {
  const local = {};
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { sync, posts } = fixture(t, { get: async () => ({ ...local }), set: async (values) => {
    await gate;
    Object.assign(local, values);
  } });
  const pull = sync.hydrate();
  const push = sync.flush();
  release();
  await Promise.all([pull, push]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].augmentorModel, "remote-model");
});

test("Settings Push leaves the pending message for failure and successful recovery", async (t) => {
  const dom = new JSDOM("<main></main>");
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, bridge: true }), { status: 200 });
  t.after(() => { globalThis.document = previousDocument; globalThis.fetch = previousFetch; dom.window.close(); });
  const state = { lastError: null, lastPushAt: 0 };
  let fail = true;
  renderBridgeTargetSection(document.querySelector("main"), { prefsSync: {
    getState: () => ({ ...state }),
    flush: async () => { state.lastError = fail ? "Local preference storage is unavailable." : null; state.lastPushAt = fail ? 0 : Date.now(); },
  } });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  const card = document.querySelector(".settings-provider-card");
  const push = [...card.querySelectorAll("button")].find((button) => button.textContent === "Push to bridge now");
  push.click();
  await tick();
  assert.match(card.querySelector(".settings-status").textContent, /Push failed: Local preference storage/);
  fail = false;
  push.click();
  await tick();
  assert.equal(card.querySelector(".settings-status").textContent, "Preferences pushed to bridge.");
});
