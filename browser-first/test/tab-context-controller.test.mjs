import assert from "node:assert/strict";
import test from "node:test";

import {
  createTabContextController,
  parseTabMention
} from "../resonantos-side-panel-extension/src/lib/tab-context-controller.js";

function createHarness(overrides = {}) {
  const events = [];
  const listeners = {
    activated: [],
    storage: [],
    updated: []
  };
  const tabs = overrides.tabs ?? [
    { id: 1, title: "ResonantOS", url: "https://resonantos.com/" },
    { id: 2, title: "Manolo Booking", url: "https://manoloremiddi.com/booking" },
    { id: 3, title: "Extension", url: "chrome://extensions/" }
  ];
  let controlledTabId = overrides.controlledTabId ?? null;
  let lastSnapshot = { title: "old" };
  const chrome = {
    storage: {
      local: {
        get: async (key) => {
          events.push(["storage-get", key]);
          return overrides.draft ? { augmentorInlineDraft: overrides.draft } : {};
        },
        remove: async (key) => events.push(["storage-remove", key])
      },
      onChanged: {
        addListener: (listener) => listeners.storage.push(listener)
      }
    },
    tabs: {
      onActivated: {
        addListener: (listener) => listeners.activated.push(listener)
      },
      onUpdated: {
        addListener: (listener) => listeners.updated.push(listener)
      },
      query: async () => tabs,
      update: async (id, patch) => events.push(["tab-update", id, patch])
    }
  };
  const controller = createTabContextController({
    addMessage: async (role, content, options) => events.push(options ? ["message", role, content, options] : ["message", role, content]),
    chrome,
    getControlledTabId: () => controlledTabId,
    isReadableBrowserTab: (tab) => /^https?:\/\//i.test(String(tab?.url ?? "")),
    readTabPage: overrides.readTabPage ?? (async (tab) => ({
      ok: true,
      tab,
      snapshot: { title: tab.title, url: tab.url, text: `Visible text of ${tab.title}` }
    })),
    refreshTabContext: async () => events.push(["refresh"]),
    renderSitePermissionPanel: async (tab) => events.push(["render-site", tab?.id ?? null]),
    setContextMeter: (value) => events.push(["meter", value]),
    setControlledTabId: (id) => {
      controlledTabId = id;
      events.push(["controlled", id]);
    },
    setLastSnapshot: (snapshot) => {
      lastSnapshot = snapshot;
      events.push(["snapshot", snapshot]);
    },
    sitePermissionStorageKey: "augmentorSitePermissions"
  });
  return {
    controller,
    events,
    getControlledTabId: () => controlledTabId,
    getLastSnapshot: () => lastSnapshot,
    listeners
  };
}

test("tab context controller parses tab mentions", () => {
  assert.equal(parseTabMention("use @tab 2"), "tab 2");
  assert.equal(parseTabMention("look at @Booking."), "Booking");
  assert.equal(parseTabMention("no tab here"), null);
});

test("tab context controller leaves email/handle @ alone (Tom's regression)", () => {
  // The previous parseTabMention started with a bare `@` which matched the
  // `acme` segment of `bob@acme.com`. The boundary prefix now requires a
  // word-boundary-style prefix so these collapse to null.
  assert.equal(parseTabMention("bob@acme.com"), null);
  assert.equal(parseTabMention("email bob@acme.com, sue@corp.io re: plan"), null);
  assert.equal(parseTabMention("contact @someone on X"), "someone");
  assert.equal(parseTabMention("plain @booking"), "booking");
});

test("tab context controller resolves mentions by tab index, title, and url", async () => {
  const harness = createHarness();

  assert.equal((await harness.controller.resolveTabMention("use @tab 2"))?.id, 2);
  assert.equal((await harness.controller.resolveTabMention("use @booking"))?.id, 2);
  assert.equal((await harness.controller.resolveTabMention("use @resonantos.com"))?.id, 1);
  assert.equal(await harness.controller.resolveTabMention("no mention"), null);
});

test("tab context controller binds mentioned tab and clears stale context", async () => {
  const harness = createHarness();
  const tab = await harness.controller.bindMentionedTab("switch to @booking");

  assert.equal(tab.id, 2);
  assert.equal(harness.getControlledTabId(), 2);
  assert.equal(harness.getLastSnapshot(), null);
  assert.deepEqual(harness.events.filter((event) => event[0] === "tab-update")[0], ["tab-update", 2, { active: true }]);
  assert.ok(harness.events.some((event) => event[0] === "meter" && event[1] === null));
  assert.ok(harness.events.some((event) => event[0] === "render-site" && event[1] === 2));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Using @tab context/.test(event[2])));
});

test("tab context controller consumes inline drafts and clears local draft storage", async () => {
  const harness = createHarness();
  await harness.controller.consumeInlineDraft({
    selection: "selected page text",
    title: "A page",
    url: "https://example.com/"
  });

  assert.ok(harness.events.some((event) => event[0] === "message" && /Inline Assistant context received/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "storage-remove" && event[1] === "augmentorInlineDraft"));
});

test("tab context controller wires storage and tab listeners", async () => {
  const harness = createHarness({ controlledTabId: 2 });
  harness.controller.bindBrowserListeners();

  assert.equal(harness.listeners.storage.length, 1);
  assert.equal(harness.listeners.activated.length, 1);
  assert.equal(harness.listeners.updated.length, 1);

  harness.listeners.storage[0]({ augmentorSitePermissions: { newValue: {} } }, "local");
  harness.listeners.storage[0]({ augmentorInlineDraft: { newValue: { selection: "draft" } } }, "local");
  harness.listeners.activated[0]();
  harness.listeners.updated[0](1, { status: "complete" });
  harness.listeners.updated[0](2, { status: "complete" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(harness.events.some((event) => event[0] === "render-site"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Inline Assistant context/.test(event[2])));
  assert.equal(harness.events.filter((event) => event[0] === "refresh").length, 2);
});

test("tab context controller hydrates initial context and pending draft", async () => {
  const harness = createHarness({ draft: { selection: "pending", title: "Draft page" } });
  await harness.controller.hydrateInitialContext();

  assert.ok(harness.events.some((event) => event[0] === "refresh"));
  assert.ok(harness.events.some((event) => event[0] === "storage-get" && event[1] === "augmentorInlineDraft"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Draft page/.test(event[2])));
});

test("tab context controller resolves a cross-tab comparison with provenance and a visible skip reason", async () => {
  const harness = createHarness();
  const result = await harness.controller.resolveComparisonContext("compare @ResonantOS, @Booking, and @Extension");

  // Two readable tabs resolved with title/URL provenance; the internal tab skipped visibly.
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].title, "ResonantOS");
  assert.equal(result.items[1].title, "Manolo Booking");
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /not a readable web page/);
  // The comparison summary (with per-tab provenance) and the skip reason are visible.
  assert.ok(harness.events.some((event) =>
    event[0] === "message" && /Comparing 2 tabs/.test(event[2]) && /ResonantOS/.test(event[2]) && /Manolo Booking/.test(event[2])
  ));
  assert.ok(harness.events.some((event) => event[0] === "message" && /not a readable web page/.test(event[2])));
  // Comparison does NOT activate any tab (no focus-steal). The user must
  // follow up with a single-mention bind to switch.
  assert.equal(harness.getControlledTabId(), null);
  assert.equal(harness.events.filter((event) => event[0] === "tab-update").length, 0);
});

test("tab context controller asks for clarification on an ambiguous @tab comparison", async () => {
  const harness = createHarness({
    tabs: [
      { id: 1, title: "BBC News", url: "https://bbc.co.uk/news" },
      { id: 2, title: "Reuters News", url: "https://reuters.com/news" }
    ]
  });
  const result = await harness.controller.resolveComparisonContext("compare @news");

  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].mention, "news");
  assert.ok(harness.events.some((event) =>
    event[0] === "message" && /@news matched 2 open tabs/.test(event[2]) && /BBC News/.test(event[2]) && /Reuters News/.test(event[2])
  ));
  // No tab is bound when the reference is ambiguous.
  assert.equal(harness.getControlledTabId(), null);
});

test("tab context controller delegates a single unambiguous mention to the single-tab bind", async () => {
  const harness = createHarness();
  const result = await harness.controller.resolveComparisonContext("switch to @booking");

  // Single unambiguous mention behaves like bindMentionedTab.
  assert.equal(result?.id, 2);
  assert.equal(harness.getControlledTabId(), 2);
  assert.ok(harness.events.some((event) => event[0] === "message" && /Using @tab context:/.test(event[2])));
});
test("tab context controller scopes quoted mentions: captures content, posts provenance chips, consumes once", async () => {
  const harness = createHarness();
  const result = await harness.controller.resolveScopedTabContext('what do @"ResonantOS" and @"Manolo Booking" say');

  assert.equal(result.contexts.length, 2);
  assert.equal(result.contexts[0].tabId, 1);
  assert.match(result.contexts[0].text, /Visible text of ResonantOS/);
  assert.equal(result.contexts[1].tabId, 2);

  const summary = harness.events.find((event) => event[0] === "message" && /Scoped to 2 referenced tabs/.test(event[2]));
  assert.ok(summary, "provenance summary is posted");
  assert.deepEqual(summary[3]?.chips, [
    { title: "ResonantOS", url: "https://resonantos.com/" },
    { title: "Manolo Booking", url: "https://manoloremiddi.com/booking" }
  ]);
  // Scoping never activates or binds a tab.
  assert.equal(harness.getControlledTabId(), null);
  assert.equal(harness.events.some((event) => event[0] === "tab-update"), false);

  const consumed = harness.controller.consumeScopedTabContexts();
  assert.equal(consumed.length, 2);
  assert.deepEqual(harness.controller.consumeScopedTabContexts(), [], "scope is consumed once and cannot leak into a later turn");
});

test("tab context controller fails loudly on an unresolved quoted reference and never widens scope", async () => {
  const harness = createHarness();
  const result = await harness.controller.resolveScopedTabContext('summarize @"Closed Tab"');

  assert.equal(result.contexts.length, 0);
  assert.ok(harness.events.some((event) =>
    event[0] === "message" && /"Closed Tab" could not be resolved/.test(event[2]) && /scope was not widened/.test(event[2])
  ));
  assert.equal(harness.controller.consumeScopedTabContexts().length, 0);
});

test("tab context controller keeps unresolved bare mentions silent in the scoped path", async () => {
  const harness = createHarness();
  await harness.controller.resolveScopedTabContext('sum @"ResonantOS" and @nothing-matches-this');

  assert.equal(harness.events.some((event) => event[0] === "message" && /nothing-matches-this/.test(String(event[2]))), false);
  assert.equal(harness.controller.consumeScopedTabContexts().length, 1);
});

test("tab context controller skips unreadable captures with a visible reason", async () => {
  const harness = createHarness({
    readTabPage: async (tab) => ({ ok: false, tab, error: "receiving end does not exist" })
  });
  const result = await harness.controller.resolveScopedTabContext('sum @"ResonantOS"');

  assert.equal(result.contexts.length, 0);
  assert.ok(harness.events.some((event) => event[0] === "message" && /could not read "ResonantOS"/.test(event[2])));
});
