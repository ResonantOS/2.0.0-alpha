import assert from "node:assert/strict";
import test from "node:test";

import { createSitePermissionStore } from "../resonantos-side-panel-extension/src/lib/site-permission-store.js";

function createHarness(initial = {}, overrides = {}) {
  const writes = [];
  const storage = {
    get: async (key) => {
      if (overrides.getError) throw new Error(overrides.getError);
      return { [key]: initial[key] ?? {} };
    },
    set: async (payload) => {
      if (overrides.setError) throw new Error(overrides.setError);
      writes.push(payload);
      Object.assign(initial, payload);
    }
  };
  const store = createSitePermissionStore({
    storage,
    sitePermissionStorageKey: "augmentorSitePermissions"
  });
  return { initial, store, writes };
}

test("site permission store normalizes site keys", () => {
  const harness = createHarness();

  assert.equal(harness.store.siteKeyForUrl("https://www.example.com/path"), "example.com");
  assert.equal(harness.store.siteKeyForUrl("https://sub.example.com/path"), "sub.example.com");
  assert.equal(harness.store.siteKeyForUrl("not a url"), "");
});

test("site permission store returns ask-before-action by default", async () => {
  const harness = createHarness();

  assert.equal(await harness.store.permissionForUrl("https://example.com/"), "ask-before-action");
  assert.equal(await harness.store.permissionForUrl("bad-url"), "ask-before-action");
});

test("site permission store reads persisted permissions", async () => {
  const harness = createHarness({
    augmentorSitePermissions: {
      "example.com": "trusted-for-safe-actions"
    }
  });

  assert.equal(await harness.store.permissionForUrl("https://www.example.com/path"), "trusted-for-safe-actions");
});

test("site permission store persists permission updates by site key", async () => {
  const harness = createHarness({
    augmentorSitePermissions: {
      "other.example": "blocked"
    }
  });

  const result = await harness.store.setSitePermission("https://www.example.com/path", "read-only");

  assert.equal(result.key, "example.com");
  assert.equal(result.mode, "read-only");
  assert.equal(result.previousMode, "ask-before-action");
  assert.equal(result.audit.action, "set");
  assert.deepEqual(harness.writes.find((write) => write.augmentorSitePermissions), {
    augmentorSitePermissions: {
      "other.example": "blocked",
      "example.com": "read-only"
    }
  });
  assert.equal((await harness.store.sitePermissionAudit())["example.com"][0].mode, "read-only");
});

test("site permission store resets persisted permissions by site key or URL", async () => {
  const harness = createHarness({
    augmentorSitePermissions: {
      "example.com": "trusted-for-safe-actions",
      "other.example": "blocked"
    }
  });

  assert.equal(await harness.store.resetSitePermission("https://www.example.com/path"), true);
  assert.deepEqual(harness.writes.find((write) => write.augmentorSitePermissions && !write.augmentorSitePermissions["example.com"]), {
    augmentorSitePermissions: {
      "other.example": "blocked"
    }
  });
  assert.equal((await harness.store.sitePermissionAudit())["example.com"][0].action, "reset");
  assert.equal(await harness.store.resetSitePermission("missing.example"), false);
});

test("site permission store rejects invalid write targets", async () => {
  const harness = createHarness();

  await assert.rejects(() => harness.store.setSitePermission("bad-url", "blocked"), /No site is active/);
});

test("sitePermissions stays lenient for display callers", async () => {
  const harness = createHarness({}, { getError: "storage offline" });

  assert.deepEqual(await harness.store.sitePermissions(), {});
  assert.deepEqual(await createSitePermissionStore({}).sitePermissions(), {});
});


test("permissionForUrl refuses when the store cannot be read", async () => {
  const stores = [
    createHarness({}, { getError: "storage offline" }).store,
    createSitePermissionStore({ storage: undefined }),
    createSitePermissionStore({ storage: {} })
  ];
  for (const store of stores) {
    await assert.rejects(() => store.permissionForUrl("https://example.com/"), {
      code: "site-permissions-unavailable",
      message: "Site permissions could not be read."
    });
    await assert.rejects(() => store.readSitePermissions(), { code: "site-permissions-unavailable" });
  }
});

test("a permission change never writes a map it could not read", async () => {
  const harness = createHarness({ augmentorSitePermissions: { "other.example": "blocked" } }, { getError: "storage offline" });
  for (const mutate of [
    () => harness.store.setSitePermission("https://example.com/", "read-only"),
    () => harness.store.resetSitePermission("other.example")
  ]) {
    await assert.rejects(mutate, { code: "site-permissions-unavailable" });
    assert.deepEqual(harness.writes, []);
    assert.deepEqual(harness.initial.augmentorSitePermissions, { "other.example": "blocked" });
  }
});
