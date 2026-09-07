import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderRoutingSection } from "../resonantos-side-panel-extension/src/lib/settings/routing-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(t, { failWrite = false, holdWrite = false } = {}) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const strategies = ["a", "b"].map((id) => ({ id, label: id, primaryModel: "fixture-model", fallbackModels: [], costPosture: "subscription-first", hardStop: false }));
  const writes = [];
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
    return { models: [{ model: "fixture-model", label: "Fixture", providerLabel: "Fixture" }], strategies };
  } });
  await tick();
  return { root, writes, finish: () => finish(), forms: () => root.querySelectorAll("form"),
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
