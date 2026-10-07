import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelBrowserActionController } from "../resonantos-side-panel-extension/src/lib/side-panel-browser-action-controller.js";

function createHarness({ lastSnapshot = null } = {}) {
  const events = [];
  const controller = createSidePanelBrowserActionController({
    addMessage: async (role, content) => events.push(["message", role, content]),
    clickActivePageText: async (request) => events.push(["click", request]),
    detectActivePageForms: async () => events.push(["forms"]),
    getLastSnapshot: () => lastSnapshot,
    openBrowserUrl: async (target) => events.push(["open", target]),
    readActivePage: async (options) => {
      events.push(["read", options]);
      return {
        snapshot: {
          title: "Read Page",
          url: "https://example.com/read"
        }
      };
    },
    saveCurrentPageToArchive: async () => events.push(["save-page"]),
    saveResearchTrailToArchive: async (target) => events.push(["save-trail", target]),
    saveSelectionToArchive: async () => events.push(["save-selection"]),
    scrollActivePage: async (request) => events.push(["scroll", request]),
    searchBrowser: async (request) => events.push(["search", request]),
    setActivity: (...args) => events.push(["activity", ...args]),
    setStatus: (status) => events.push(["status", status]),
    summarizeCurrentPageToArchive: async () => events.push(["save-summary"]),
    summarizeSnapshot: async () => events.push(["summary"]),
    typeIntoActivePage: async (request) => events.push(["type", request])
  });
  return { controller, events };
}

test("side panel browser action controller routes archive intake targets", async () => {
  const harness = createHarness();

  await harness.controller.saveIntake("page");
  await harness.controller.saveIntake("selection");
  await harness.controller.saveIntake("summary");
  await harness.controller.saveIntake("trail dao research");

  assert.deepEqual(harness.events, [
    ["save-page"],
    ["save-selection"],
    ["save-summary"],
    ["save-trail", "dao research"]
  ]);
});

test("side panel browser action controller dispatches direct browser commands", async () => {
  const harness = createHarness();

  await harness.controller.runBrowserCommand("search latest AI news");
  await harness.controller.runBrowserCommand('click "Add to cart"');
  await harness.controller.runBrowserCommand('type "hello world" and press enter');
  await harness.controller.runBrowserCommand("scroll bottom");
  await harness.controller.runBrowserCommand("forms");
  await harness.controller.runBrowserCommand("open resonantos.com");

  assert.deepEqual(harness.events, [
    ["search", { action: "search", query: "latest AI news" }],
    ["click", { text: "Add to cart" }],
    ["type", { submit: true, text: "hello world" }],
    ["scroll", { direction: "bottom" }],
    ["forms"],
    ["open", "resonantos.com"]
  ]);
});

test("side panel browser action controller handles empty browser command helpers", async () => {
  const harness = createHarness();

  await harness.controller.runBrowserCommand("read");
  await harness.controller.runBrowserCommand("scroll");
  await harness.controller.runBrowserCommand("fields");
  await harness.controller.runBrowserCommand("");

  assert.deepEqual(harness.events.map((event) => event[0]), ["summary", "scroll", "forms", "message"]);
  assert.match(harness.events.at(-1)[2], /Use `\/browser open <url>`/);
});

test("side panel browser action controller explains structured edit boundary with page context", async () => {
  const harness = createHarness({
    lastSnapshot: {
      title: "Spreadsheet",
      url: "https://docs.example/sheet"
    }
  });

  await harness.controller.explainStructuredPageEditBoundary("change row 4");

  assert.deepEqual(harness.events[0], ["activity", "completed", "Checked active page", "Spreadsheet"]);
  assert.deepEqual(harness.events[1], ["status", "Needs precise edit target"]);
  assert.equal(harness.events.some((event) => event[0] === "read"), false);
  assert.ok(harness.events.some((event) => event[0] === "message" && /change row 4/.test(event[2])));
});

test("side panel browser action controller keeps wallet operations human-only", async () => {
  const harness = createHarness();

  await harness.controller.handleWalletBoundary();

  assert.ok(harness.events.some((event) => event[0] === "message" && /Wallet actions are human-approval gated/.test(event[2])));
  assert.deepEqual(harness.events.at(-1), ["status", "Approval gated"]);
});
