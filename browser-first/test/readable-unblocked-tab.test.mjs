// #410 — a site the user set to "blocked" is still http(s), so the scheme-only
// readability check would list it in the @tab typeahead and resolve it into a
// mention. createReadableUnblockedTab composes the scheme check with the
// site-permission store so blocked sites never appear.
import assert from "node:assert/strict";
import test from "node:test";

import {
  blockedSiteKeysFromPermissions,
  createReadableUnblockedTab
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
