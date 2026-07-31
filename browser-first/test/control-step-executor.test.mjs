import assert from "node:assert/strict";
import test from "node:test";

import { createControlStepExecutor } from "../resonantos-side-panel-extension/src/lib/control-step-executor.js";
import { createCertifiedExecutor, loadCertificationPage } from "./agent-control-certification-fixtures.mjs";

function createHarness(overrides = {}) {
  const events = [];
  const tabs = overrides.tabs ?? [
    { id: 1, active: true, title: "ResonantOS", url: "https://resonantos.com/" },
    { id: 2, active: false, title: "Booking", url: "https://manoloremiddi.com/booking" },
    { id: 3, active: false, title: "Settings", url: "chrome://extensions/" }
  ];
  let controlledTabId = overrides.controlledTabId ?? 1;
  let lastSnapshot = { title: "Cached" };
  const executor = createControlStepExecutor({
    addMessage: async (role, content) => events.push(["message", role, content]),
    chrome: {
      tabs: {
        get: async (id) => tabs.find((tab) => tab.id === id) ?? null,
        query: async () => tabs,
        update: async (id, patch) => events.push(["tab-update", id, patch])
      }
    },
    clickActivePageText: async (payload) => {
      events.push(["click", payload]);
      return { ok: true, clickedText: payload.text || payload.ref };
    },
    detectActivePageForms: async () => {
      events.push(["forms"]);
      return { ok: true, forms: [] };
    },
    getControlledTabId: () => controlledTabId,
    isReadableBrowserTab: (tab) => /^https?:\/\//i.test(String(tab?.url ?? "")),
    openBrowserUrl: async (target) => {
      events.push(["open", target]);
      return { ok: true, action: "open", url: target };
    },
    scrollActivePage: async (payload) => {
      events.push(["scroll", payload]);
      return { ok: true, direction: payload.direction };
    },
    searchBrowser: async (payload) => {
      events.push(["search", payload]);
      return { ok: true, action: payload.action, query: payload.query };
    },
    setActivity: (phase, label, detail) => events.push(["activity", phase, label, detail]),
    setContextMeter: (snapshot) => events.push(["meter", snapshot]),
    setControlledTabId: (id) => {
      controlledTabId = id;
      events.push(["controlled", id]);
    },
    setLastSnapshot: (snapshot) => {
      lastSnapshot = snapshot;
      events.push(["snapshot", snapshot]);
    },
    sleep: async (ms) => events.push(["sleep", ms]),
    summarizeSnapshot: async () => {
      events.push(["summary"]);
      return { ok: true, snapshot: lastSnapshot };
    },
    typeIntoActivePage: async (payload) => {
      events.push(["type", payload]);
      return { ok: true, typedText: payload.text };
    }
  });
  return {
    events,
    executor,
    getControlledTabId: () => controlledTabId,
    getLastSnapshot: () => lastSnapshot
  };
}

test("control step executor lists readable tabs and marks the controlled tab", async () => {
  const harness = createHarness();

  const result = await harness.executor.executeControlStep({ type: "tabs" });

  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.tabs[0].controlled, true);
  assert.equal(result.tabs.some((tab) => tab.url.startsWith("chrome:")), false);
  assert.ok(harness.events.some((event) => event[0] === "message" && /Open browser tabs/.test(event[2])));
});

test("control step executor switches readable tabs and clears stale page context", async () => {
  const harness = createHarness();

  const result = await harness.executor.executeControlStep({ type: "switch_tab", tabId: 2 });

  assert.equal(result.ok, true);
  assert.equal(harness.getControlledTabId(), 2);
  assert.equal(harness.getLastSnapshot(), null);
  assert.ok(harness.events.some((event) => event[0] === "tab-update" && event[1] === 2));
  assert.ok(harness.events.some((event) => event[0] === "meter" && event[1] === null));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Switched controlled tab/.test(event[2])));
});

test("control step executor rejects unreadable tab switches", async () => {
  const harness = createHarness();

  const result = await harness.executor.executeControlStep({ type: "switch_tab", tabId: 3 });

  assert.equal(result.ok, false);
  assert.match(result.error, /not a readable web page/);
  assert.equal(harness.getControlledTabId(), 1);
});

test("control step executor delegates browser mutation steps and waits for page state", async () => {
  const harness = createHarness();

  await harness.executor.executeControlStep({ type: "open", target: "https://example.com/" });
  await harness.executor.executeControlStep({ type: "search", action: "news", query: "ai" });
  await harness.executor.executeControlStep({ type: "click", text: "Continue", ref: "c1", userApproved: true });
  await harness.executor.executeControlStep({ type: "type", text: "hello", field: "search", submit: true });
  await harness.executor.executeControlStep({ type: "scroll", direction: "down" });
  await harness.executor.executeControlStep({ type: "forms" });
  await harness.executor.executeControlStep({ type: "wait", ms: 250 });

  assert.ok(harness.events.some((event) => event[0] === "open" && event[1] === "https://example.com/"));
  assert.ok(harness.events.some((event) => event[0] === "search" && event[1].query === "ai"));
  assert.ok(harness.events.some((event) => event[0] === "click" && event[1].ref === "c1"));
  assert.ok(harness.events.some((event) => event[0] === "type" && event[1].submit === true));
  assert.ok(harness.events.some((event) => event[0] === "scroll" && event[1].direction === "down"));
  assert.ok(harness.events.some((event) => event[0] === "forms"));
  assert.ok(harness.events.some((event) => event[0] === "sleep" && event[1] === 1200));
  assert.ok(harness.events.some((event) => event[0] === "sleep" && event[1] === 500));
  assert.ok(harness.events.some((event) => event[0] === "sleep" && event[1] === 250));
});

test("control step executor summarizes read steps and rejects unknown steps", async () => {
  const harness = createHarness();

  const read = await harness.executor.executeControlStep({ type: "read" });
  const unknown = await harness.executor.executeControlStep({ type: "unknown" });

  assert.equal(read.ok, true);
  assert.ok(harness.events.some((event) => event[0] === "summary"));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown control step/);
});

// #223: certification fixtures. The executor below is wired to the REAL
// content.js safety layer inside the fixture page (not stubs), so safe actions
// certify a completed state with observable page-side effects, and high-risk
// actions certify boundary-named denials before any page mutation.

test("#223: safe click on the certification fixture completes and visibly mutates the page", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const result = await executor.executeControlStep({ type: "click", text: "Load more", userApproved: true });

  assert.equal(result.ok, true, "safe click must complete");
  // content.js fires the dispatched click sequence and then element.click(),
  // so a single certification step can actuate the handler more than once;
  // the fixture asserts honest page-side activation (>= 1), not an exact count.
  assert.ok(win.__certClicks.loadMore >= 1, "page-side click handler must have run");
  assert.ok(win.document.getElementById("cert-feed").querySelectorAll("article").length > 12, "click must have visibly loaded a new row");
  assert.equal(win.__certActivity, "loaded more rows", "certification activity log must show the completed click");
});

test("#223: safe type into the search field on the certification fixture completes and lands the value", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const result = await executor.executeControlStep({ type: "type", text: "vintage synths", field: "Search the catalog", userApproved: true });

  assert.equal(result.ok, true, "search typing must complete");
  assert.equal(win.document.getElementById("cert-search").value, "vintage synths", "typed value must land in the page");
  assert.equal(win.__certActivity, "typed vintage synths", "certification activity log must show the typed value");
});

test("#223: safe type into the generic notes field completes and lands the value", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const result = await executor.executeControlStep({ type: "type", text: "audit notes", field: "Notes", userApproved: true });

  assert.equal(result.ok, true, "generic typing must complete");
  assert.equal(win.document.getElementById("cert-notes").value, "audit notes", "typed value must land in the page");
});

test("#223: safe scroll on the certification fixture completes and reports real scroll position", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const down = await executor.executeControlStep({ type: "scroll", direction: "down" });

  assert.equal(down.ok, true, "scroll down must complete");
  assert.ok(down.scrollY > 0, "scroll down must report a positive scroll position");
  assert.equal(win.scrollY, down.scrollY, "page-side scroll position must match the certified result");

  const top = await executor.executeControlStep({ type: "scroll", direction: "top" });

  assert.equal(top.ok, true, "scroll to top must complete");
  assert.equal(top.scrollY, 0, "scroll to top must return to the top of the page");
  assert.equal(win.__certScrollY, 0, "page-side scroll listener must observe the top position");
});

test("#223: wallet connect click is denied with the wallet boundary named", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const result = await executor.executeControlStep({ type: "click", text: "Connect wallet", userApproved: true });

  assert.equal(result.ok, false, "wallet connect must be denied to automation");
  assert.equal(result.approvalRequired, true);
  assert.equal(result.deniedToAutomation, true);
  assert.match(result.error, /wallet|payment|login|credential/, "denial must name the wallet/payment boundary, not an ambiguous target");
  assert.equal(win.__certClicks.wallet, 0, "the wallet control must never be actuated");
  assert.equal(win.__certActivity, "fixture ready", "the page must remain untouched by the denied click");
});

test("#223: public submit clicks are denied as human-only handoffs", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const order = await executor.executeControlStep({ type: "click", text: "Place order", userApproved: true });

  assert.equal(order.ok, false, "Place order must be denied");
  assert.equal(order.deniedToAutomation, true);
  assert.equal(order.humanHandoff, true);
  assert.match(order.error, /public submit|commit|human/, "denial must name the public-submit boundary");
  assert.equal(win.__certClicks.placeOrder, 0, "the order control must never be actuated");

  const post = await executor.executeControlStep({ type: "click", text: "Post comment", userApproved: true });

  assert.equal(post.ok, false, "Post comment must be denied");
  assert.equal(post.humanHandoff, true);
  assert.match(post.error, /public submit|commit|human/, "denial must name the public-submit boundary");
  assert.equal(win.__certClicks.post, 0, "the post control must never be actuated");
});

test("#223: typing into credential and payment fields is denied with the boundary named and values untouched", async () => {
  const { win, send } = await loadCertificationPage();
  const { executor } = createCertifiedExecutor({ win, send });

  const password = await executor.executeControlStep({ type: "type", text: "hunter2", field: "Password", userApproved: true });

  assert.equal(password.ok, false, "password typing must be denied");
  assert.equal(password.deniedToAutomation, true);
  assert.equal(password.fieldSafety.kind, "credential", "denial must report the credential boundary");
  assert.match(password.error, /credential|human/i, "denial message must name the boundary");
  assert.equal(win.document.getElementById("cert-password").value, "", "the password field must stay empty");

  const card = await executor.executeControlStep({ type: "type", text: "4111 2222 3333 4444", field: "Card number", userApproved: true });

  assert.equal(card.ok, false, "card number typing must be denied");
  assert.equal(card.fieldSafety.kind, "payment", "denial must report the payment boundary");
  assert.match(card.error, /payment|human/i, "denial message must name the boundary");
  assert.equal(win.document.getElementById("cert-card").value, "", "the card field must stay empty");
});
