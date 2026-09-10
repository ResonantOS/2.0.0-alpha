import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderRoutingSection } from "../resonantos-side-panel-extension/src/lib/settings/routing-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(t, { failWrite = false, holdWrite = false, refreshFailure = false } = {}) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const strategies = ["a", "b"].map((id) => ({ id, label: id, primaryModel: "fixture-model", fallbackModels: [], costPosture: "subscription-first", hardStop: false }));
  const writes = [];
  let failRead = refreshFailure;
  let finish;
  const root = document.querySelector("main");
  renderRoutingSection(root, { bridgeRequest: async (_route, options) => {
    if (options.method === "POST") {
      writes.push(options.body);
      if (failWrite) throw Error("fixture write failed");
      if (holdWrite) await new Promise((resolve) => { finish = resolve; });
      Object.assign(strategies.find((strategy) => strategy.id === options.body.strategyId), options.body);
      return { ok: true };
    }
    if (writes.length && failRead) throw Error("fixture refresh failed");
    return { models: [{ model: "fixture-model", label: "Fixture", providerLabel: "Fixture" }], strategies };
  } });
  await tick();
  return { root, writes, strategies, recover: () => { failRead = false; }, finish: () => finish(), forms: () => root.querySelectorAll("form"),
    submit: (index) => root.querySelectorAll("form")[index].dispatchEvent(new dom.window.Event("submit", { cancelable: true })) };
}

test("saving one routing strategy preserves another strategy's unsaved fallback and hard-stop edits", async (t) => {
  const ui = await setup(t);
  const draft = ui.forms()[1];
  draft.elements.fallbackModels.value = "fixture-fallback";
  draft.elements.hardStop.checked = true;
  ui.forms()[0].elements.costPosture.value = "quality-first";
  ui.submit(0); await tick();
  assert.equal(ui.forms()[1], draft);
  assert.equal(draft.elements.fallbackModels.value, "fixture-fallback");
  assert.equal(draft.elements.hardStop.checked, true);
  assert.equal(ui.forms()[0].elements.costPosture.value, "quality-first");
  ui.submit(1); await tick();
  assert.equal(ui.writes.length, 2);
  assert.deepEqual(ui.writes[1].fallbackModels, ["fixture-fallback"]);
  assert.equal(ui.writes[1].hardStop, true);
});

test("failed routing save preserves both forms and exposes the error", async (t) => {
  const ui = await setup(t, { failWrite: true });
  ui.forms()[0].elements.fallbackModels.value = "first-draft";
  ui.forms()[1].elements.fallbackModels.value = "second-draft";
  ui.submit(0); await tick();
  assert.equal(ui.forms()[0].elements.fallbackModels.value, "first-draft");
  assert.equal(ui.forms()[1].elements.fallbackModels.value, "second-draft");
  assert.match(ui.root.querySelector(".settings-status").textContent, /Save failed/);
});

test("edits made while a different strategy is saving survive its refresh", async (t) => {
  const ui = await setup(t, { holdWrite: true });
  ui.submit(0); ui.submit(0);
  assert.equal(ui.writes.length, 1);
  ui.forms()[1].elements.costPosture.value = "low-cost-first";
  ui.finish(); await tick();
  assert.equal(ui.forms()[1].elements.costPosture.value, "low-cost-first");
});

test("saving refreshes sibling health and badges without replacing its focused draft form", async (t) => {
  const ui = await setup(t, { holdWrite: true });
  const draft = ui.forms()[1];
  draft.elements.fallbackModels.value = "unsaved";
  ui.submit(0);
  draft.elements.fallbackModels.focus();
  ui.strategies[1].routeState = "routable";
  ui.strategies[1].primary = { label: "Updated route", providerLabel: "Fixture", state: "ready" };
  ui.finish(); await tick();
  const sibling = ui.root.querySelector('[data-strategy-id="b"]');
  assert.equal(ui.forms()[1], draft);
  assert.equal(document.activeElement, draft.elements.fallbackModels);
  assert.equal(draft.elements.fallbackModels.value, "unsaved");
  assert.equal(sibling.dataset.state, "routable");
  assert.match(sibling.querySelector(".settings-route-badge").textContent, /Updated route.*ready/);
});

test("a missing saved card is restored rather than silently skipped", async (t) => {
  const ui = await setup(t, { holdWrite: true });
  ui.submit(0);
  ui.root.querySelector('[data-strategy-id="a"]').remove();
  ui.finish(); await tick();
  assert.ok(ui.root.querySelector('[data-strategy-id="a"]'));
});

test("saved routing with failed refresh offers read-only recovery and preserves sibling drafts", async (t) => {
  const ui = await setup(t, { refreshFailure: true });
  const draft = ui.forms()[1];
  draft.elements.fallbackModels.value = "unsaved";
  ui.submit(0); await tick();
  const status = ui.root.querySelector(".settings-status");
  assert.match(status.textContent, /saved.*refresh failed/i);
  assert.doesNotMatch(status.textContent, /Save failed/);
  const retry = [...ui.root.querySelectorAll("button")].find((button) => button.textContent === "Refresh routing status");
  assert.equal(retry.hidden, false);
  ui.submit(0);
  retry.click(); await tick();
  assert.equal(ui.writes.length, 1);
  assert.equal(retry.hidden, false);
  ui.recover();
  retry.click(); retry.click(); await tick();
  assert.equal(ui.writes.length, 1);
  assert.equal(ui.forms()[1], draft);
  assert.equal(draft.elements.fallbackModels.value, "unsaved");
  assert.match(status.textContent, /refreshed/i);
});

test("a missing saved strategy response remains an explicit refresh failure", async (t) => {
  const ui = await setup(t, { holdWrite: true });
  ui.submit(0);
  ui.finish();
  // Let persistence finish, then change the following read's response.
  queueMicrotask(() => ui.strategies.splice(0, 1));
  await tick();
  assert.match(ui.root.querySelector(".settings-status").textContent, /missing.*refreshed routing response/);
});
