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

const isHttp = (tab) => /^https?:\/\//i.test(String(tab?.url ?? ""));
const siteKeyForUrl = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

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
