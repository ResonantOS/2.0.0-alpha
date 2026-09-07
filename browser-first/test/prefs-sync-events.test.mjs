import assert from "node:assert/strict";
import test from "node:test";
import { createPrefsSync } from "../resonantos-side-panel-extension/src/lib/prefs-sync.js";

test("StorageArea changes push only synced keys, coalesce and use the current bridge", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Set();
  const posts = [];
  let active = "first";
  const local = { augmentorModel: "model-a" };
  const sync = createPrefsSync({
    storage: { get: async () => ({ ...local }), onChanged: {
      addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    } },
    getBridgeRequest: () => async (_, options) => { posts.push({ active, body: options.body }); return { ok: true }; },
  });
  t.after(() => sync.teardown());
  sync.install();
  const emit = (changes) => { for (const fn of listeners) fn(changes); };
  emit({ unrelated: { newValue: "ignored" } });
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0);
  emit({ augmentorModel: { newValue: "model-a" } });
  local.augmentorModel = "model-b";
  emit({ augmentorModel: { newValue: "model-b" } });
  active = "second";
  assert.equal(sync.getState().pending, true);
  t.mock.timers.tick(800);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].active, "second");
  assert.equal(posts[0].body.prefs.augmentorModel, "model-b");
  sync.teardown();
  assert.equal(listeners.size, 0);
  emit({ augmentorModel: { newValue: "model-c" } });
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 1);
});

test("teardown cancels a pending debounced push", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let changed;
  let writes = 0;
  const sync = createPrefsSync({ storage: {
    get: async () => ({}), onChanged: { addListener(fn) { changed = fn; }, removeListener() {} },
  }, bridgeRequest: async () => { writes++; return { ok: true }; } });
  sync.install();
  changed({ augmentorModel: { newValue: "model" } });
  assert.equal(sync.getState().pending, true);
  sync.teardown();
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});
