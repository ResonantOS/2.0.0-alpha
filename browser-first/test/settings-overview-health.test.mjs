import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderOverviewSection } from "../resonantos-side-panel-extension/src/lib/settings/overview-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(t, bridgeRequest) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const root = document.querySelector("main");
  renderOverviewSection(root, { bridgeRequest });
  return {
    root,
    status: root.querySelector(".settings-status"),
    bridge: () => [...root.querySelectorAll(".settings-health-card")]
      .find((card) => card.querySelector("span").textContent === "Browser bridge")
  };
}

test("overview does not claim bridge connectivity before the health request completes", async (t) => {
  let finish;
  const status = new Promise((resolve) => { finish = resolve; });
  const ui = setup(t, async (route) => route === "/status" ? status : { providers: [] });
  assert.equal(ui.bridge().querySelector("strong").textContent, "Checking");
  assert.notEqual(ui.bridge().dataset.tone, "success");
  finish({ addons: [], memory: {} });
  await tick();
  assert.equal(ui.bridge().querySelector("strong").textContent, "Connected");
  assert.equal(ui.bridge().dataset.tone, "success");
  assert.equal(ui.status.getAttribute("role"), "status");
});

for (const failure of ["Failed to fetch", "Bridge authentication failed"]) {
  test(`overview reports an unavailable bridge when health requests fail: ${failure}`, async (t) => {
    const ui = setup(t, async () => { throw new Error(failure); });
    await tick();
    assert.equal(ui.bridge().querySelector("strong").textContent, "Unavailable");
    assert.equal(ui.bridge().dataset.tone, "warning");
    assert.match(ui.bridge().textContent, /Diagnostics/);
    assert.equal(ui.status.dataset.tone, "warning");
    assert.doesNotMatch(ui.bridge().textContent, /Ready|Connected/);
  });
}

test("provider failure does not hide confirmed bridge connectivity", async (t) => {
  const ui = setup(t, async (route) => {
    if (route === "/providers/status") throw new Error("provider status unavailable");
    return { addons: [], memory: {} };
  });
  await tick();
  assert.equal(ui.bridge().querySelector("strong").textContent, "Connected");
  assert.equal(ui.status.dataset.tone, "warning");
});

test("provider success cannot substitute for a failed host health check", async (t) => {
  const ui = setup(t, async (route) => {
    if (route === "/status") throw new Error("status unavailable");
    return { providers: [{ configured: true }] };
  });
  await tick();
  assert.equal(ui.bridge().querySelector("strong").textContent, "Unavailable");
  assert.match(ui.root.textContent, /1\/1/);
  assert.equal(ui.status.dataset.tone, "warning");
});
