// #410 — a site the user set to "blocked" is still http(s), so the scheme-only
// readability check would list it in the @tab typeahead and resolve it into a
// mention. createReadableUnblockedTab composes the scheme check with the
// site-permission store so blocked sites never appear.
import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedSiteKeysFromPermissions,
  createBlockedSiteSnapshot,
  createReadableUnblockedTab,
  wireBlockedSiteTypeahead
} from "../resonantos-side-panel-extension/src/lib/readable-unblocked-tab.js";
import { createSitePermissionStore } from "../resonantos-side-panel-extension/src/lib/site-permission-store.js";
import { rankMentionCandidates } from "../resonantos-side-panel-extension/src/lib/tab-mention-typeahead.js";
import { resolveScopedTabs } from "../resonantos-side-panel-extension/src/lib/tab-comparison-resolver.js";

const isHttp = (tab) => /^https?:\/\//i.test(String(tab?.url ?? ""));
const siteKeyForUrl = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// Minimal in-memory chrome.storage.local stand-in (single-key get, merge set).
function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    async get(key) {
      return key in store ? { [key]: store[key] } : {};
    },
    async set(obj) {
      Object.assign(store, obj);
    }
  };
}

test("blockedSiteKeysFromPermissions keeps only sites set to blocked", () => {
  const keys = blockedSiteKeysFromPermissions({
    "alpha.test": "blocked",
    "beta.test": "allow-once",
    "gamma.test": "ask-before-action",
    "delta.test": "blocked"
  });
  assert.deepEqual([...keys].sort(), ["alpha.test", "delta.test"]);
});

test("createReadableUnblockedTab drops blocked sites but keeps other readable tabs", () => {
  const blocked = new Set(["blocked.test"]);
  const predicate = createReadableUnblockedTab({
    isReadableBrowserTab: isHttp,
    siteKeyForUrl,
    getBlockedSiteKeys: () => blocked
  });

  assert.equal(predicate({ url: "https://alpha.test/" }), true, "unblocked http tab is readable");
  assert.equal(predicate({ url: "https://www.blocked.test/page" }), false, "blocked site (www-normalized) is filtered");
  assert.equal(predicate({ url: "https://blocked.test/" }), false, "blocked site is filtered");
  assert.equal(predicate({ url: "chrome://settings/" }), false, "non-http tab still fails the scheme check");
});

test("createReadableUnblockedTab reflects the latest blocked set on each call", () => {
  let blocked = new Set();
  const predicate = createReadableUnblockedTab({
    isReadableBrowserTab: isHttp,
    siteKeyForUrl,
    getBlockedSiteKeys: () => blocked
  });

  assert.equal(predicate({ url: "https://alpha.test/" }), true);
  blocked = new Set(["alpha.test"]);
  assert.equal(predicate({ url: "https://alpha.test/" }), false, "getter is re-read so storage changes take effect");
});

test("createReadableUnblockedTab treats an unparseable host as not-blocked (scheme check governs)", () => {
  const predicate = createReadableUnblockedTab({
    isReadableBrowserTab: () => true,
    siteKeyForUrl,
    getBlockedSiteKeys: () => new Set([""])
  });
  // "" can never be a real blocked key (setSitePermission rejects empty keys),
  // so an unparseable URL is governed solely by isReadableBrowserTab.
  assert.equal(predicate({ url: "not a url" }), true);
});

test("createReadableUnblockedTab fails closed until site permissions have loaded (#410)", () => {
  let loaded = false;
  const predicate = createReadableUnblockedTab({
    isReadableBrowserTab: isHttp,
    siteKeyForUrl,
    getBlockedSiteKeys: () => new Set(), // nothing yet known to be blocked
    isPermissionsLoaded: () => loaded
  });

  // Before the first load, a keyable http(s) site is withheld even though the
  // blocked set is empty — so a site that may turn out to be blocked is never
  // listed during the async load window.
  assert.equal(predicate({ url: "https://alpha.test/" }), false, "keyable site withheld before the first load");
  assert.equal(predicate({ url: "chrome://settings/" }), false, "non-http still fails the scheme check");

  loaded = true;
  assert.equal(predicate({ url: "https://alpha.test/" }), true, "listed once the permission snapshot has loaded");
});

test("a stored 'blocked' permission removes the site from typeahead AND resolver output (#410 integration)", async () => {
  // Real site-permission store over in-memory storage, with one site blocked —
  // exercising the full composition side-panel.js wires, not an injected fake.
  const store = createSitePermissionStore({
    storage: memoryStorage(),
    sitePermissionStorageKey: "augmentorSitePermissions"
  });
  await store.setSitePermission("https://blocked.test/", "blocked");

  const blocked = blockedSiteKeysFromPermissions(await store.sitePermissions());
  const isReadableUnblockedTab = createReadableUnblockedTab({
    isReadableBrowserTab: isHttp,
    siteKeyForUrl: store.siteKeyForUrl,
    getBlockedSiteKeys: () => blocked,
    isPermissionsLoaded: () => true
  });

  const tabs = [
    { id: 1, title: "Allowed Site", url: "https://allowed.test/" },
    { id: 2, title: "Blocked Site", url: "https://blocked.test/dashboard" }
  ];

  // Typeahead: the blocked site is not listed.
  const listed = rankMentionCandidates(tabs, "", isReadableUnblockedTab).map((candidate) => candidate.title);
  assert.deepEqual(listed, ["Allowed Site"], "blocked site is absent from the @tab typeahead");

  // Resolver: a deliberate @"Blocked Site" reference does not resolve into scope;
  // it is skipped (fail loud) rather than silently widening scope.
  const scoped = resolveScopedTabs('scope @"Allowed Site" and @"Blocked Site"', tabs, isReadableUnblockedTab);
  assert.deepEqual(scoped.items.map((item) => item.title), ["Allowed Site"], "only the allowed site is scoped");
  assert.ok(
    scoped.skipped.some((entry) => /blocked\.test|Blocked Site/.test(`${entry.title} ${entry.url} ${entry.reason}`)),
    "the blocked-site reference is skipped, not resolved"
  );

  // Non-vacuity control: with the UNFILTERED scheme predicate wired instead —
  // the exact regression the reviewer named — the blocked site WOULD appear.
  const unfiltered = rankMentionCandidates(tabs, "", isHttp).map((candidate) => candidate.title);
  assert.deepEqual(unfiltered, ["Allowed Site", "Blocked Site"], "control: the raw predicate leaks the blocked site");
});

test("wireBlockedSiteTypeahead ignores unrelated changes and still closes when the refresh rejects (#410)", async () => {
  const calls = [];
  const typeahead = { close: () => calls.push("close") };
  const listeners = [];
  const onChanged = { addListener: (fn) => listeners.push(fn) };
  const fire = (changes, area) => listeners.forEach((fn) => fn(changes, area));

  // A refresh that REJECTS must not strand a stale popup: finally() still closes.
  const refreshBlockedSiteKeys = async () => {
    calls.push("refresh");
    throw new Error("storage read failed");
  };
  wireBlockedSiteTypeahead({ onChanged, storageKey: "sitePerms", refreshBlockedSiteKeys, typeahead });

  // Wrong key and wrong area are both ignored — no refresh, no close.
  fire({ otherKey: { newValue: 1 } }, "local");
  fire({ sitePerms: { newValue: {} } }, "sync");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [], "an unrelated change neither refreshes nor closes");

  // The subscribed change refreshes, then closes even though the refresh threw.
  fire({ sitePerms: { newValue: {} } }, "local");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["refresh", "close"], "the popup is closed after the (rejected) refresh");
});

// Rejecting real store: storage.get throws, exercised through the REAL
// createSitePermissionStore.readSitePermissions — not a throwing refresh stub.
const rejectingStore = () =>
  createSitePermissionStore({
    storage: { get: async () => { throw new Error("storage unavailable"); } },
    sitePermissionStorageKey: "augmentorSitePermissions"
  });

test("createBlockedSiteSnapshot fails closed when the store's read rejects (#509 Important)", async () => {
  // A failed permission read must not make the typeahead/resolver fail open: with
  // the blocked set unknown, no keyable site may be listed. The snapshot is handed
  // the whole store and selects the STRICT reader itself, so this also pins that
  // selection: switch the factory to the lenient sitePermissions() and it goes red.
  const store = rejectingStore();
  const { isReadableUnblockedTab, refresh } = createBlockedSiteSnapshot({
    isReadableBrowserTab: isHttp,
    sitePermissionStore: store
  });

  await assert.rejects(refresh(), /could not be read/, "a failed read rejects so callers can fail closed");
  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), false, "no keyable site is listed after a failed read");
  assert.equal(isReadableUnblockedTab({ url: "https://blocked.test/" }), false, "a blockable site is certainly not listed");
});

test("createBlockedSiteSnapshot rejects a store that lacks the strict reader, so the lenient one can't be wired in (#509)", () => {
  // The snapshot chooses the reader by name from the store, not from a parameter,
  // so a caller cannot substitute the lenient sitePermissions() that resolves a
  // failed read to {} (the regression the finding named). A store missing either
  // method is rejected at construction — a miswire fails loudly here rather than
  // silently failing open.
  assert.throws(
    () => createBlockedSiteSnapshot({ isReadableBrowserTab: isHttp }),
    /readSitePermissions\(\) and siteKeyForUrl\(\)/,
    "no store at all is refused"
  );
  assert.throws(
    () => createBlockedSiteSnapshot({ isReadableBrowserTab: isHttp, sitePermissionStore: { siteKeyForUrl } }),
    /readSitePermissions/,
    "a store without the strict reader is refused"
  );
});

test("createBlockedSiteSnapshot: if the store's strict reader swallowed errors it would fail OPEN (#509 control)", async () => {
  // Proves why readSitePermissions MUST reject on a failed read (pinned in
  // site-permission-store.test.mjs). Modelled with a broken store whose strict
  // reader is the lenient sitePermissions(): a failed read resolves to {}, so
  // refresh() sets loaded = true with an empty blocked set and lists every keyable
  // site — the exact regression the finding named. The real snapshot can't reach
  // this (it selects readSitePermissions by name over a real store), so this control
  // pins the dependency: a future change making readSitePermissions lenient
  // re-surfaces here, and the Important test above goes red too.
  const real = rejectingStore();
  const brokenStore = { readSitePermissions: real.sitePermissions, siteKeyForUrl: real.siteKeyForUrl };
  const { isReadableUnblockedTab, refresh } = createBlockedSiteSnapshot({
    isReadableBrowserTab: isHttp,
    sitePermissionStore: brokenStore
  });

  await refresh(); // resolves (error swallowed by the broken reader), does NOT reject
  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), true, "control: a swallowing reader lists a keyable site after a failed read");
});

test("createBlockedSiteSnapshot lists unblocked and hides blocked after a successful load (#509)", async () => {
  const store = createSitePermissionStore({ storage: memoryStorage(), sitePermissionStorageKey: "augmentorSitePermissions" });
  await store.setSitePermission("https://blocked.test/", "blocked");
  const { isReadableUnblockedTab, refresh } = createBlockedSiteSnapshot({
    isReadableBrowserTab: isHttp,
    sitePermissionStore: store
  });

  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), false, "fails closed until the first load resolves");
  await refresh();
  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), true, "an unblocked site is listed after load");
  assert.equal(isReadableUnblockedTab({ url: "https://blocked.test/" }), false, "a blocked site stays hidden");
});

test("createBlockedSiteSnapshot flips back to fail-closed when a later read rejects (#509)", async () => {
  let fail = false;
  const store = createSitePermissionStore({
    storage: { get: async () => { if (fail) throw new Error("gone"); return {}; } },
    sitePermissionStorageKey: "augmentorSitePermissions"
  });
  const { isReadableUnblockedTab, refresh } = createBlockedSiteSnapshot({
    isReadableBrowserTab: isHttp,
    sitePermissionStore: store
  });

  await refresh();
  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), true, "listed after a successful load");
  fail = true;
  await assert.rejects(refresh(), /could not be read/);
  assert.equal(isReadableUnblockedTab({ url: "https://alpha.test/" }), false, "a later failed read fails closed again");
});
