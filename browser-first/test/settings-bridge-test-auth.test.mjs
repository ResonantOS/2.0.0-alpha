import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderBridgeTargetSection } from "../resonantos-side-panel-extension/src/lib/settings/bridge-target-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const url = "http://127.0.0.1:47773";
const token = "fixture-generated-token";

async function setup(t) {
  const dom = new JSDOM("<main></main>");
  const keys = ["document", "chrome", "fetch", "__RESONANTOS_BRIDGE_CONFIG__"];
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => {
    dom.window.close();
    keys.forEach((key, index) => {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]);
      else delete globalThis[key];
    });
  });
  globalThis.document = dom.window.document;
  let writes = 0;
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => { writes++; } } } };
  globalThis.__RESONANTOS_BRIDGE_CONFIG__ = { bridgeUrl: url, bridgeToken: token };
  const calls = [];
  globalThis.fetch = async (target, options = {}) => {
    calls.push({ target, headers: options.headers });
    const ok = options.headers?.["X-ResonantOS-Bridge-Token"] === token;
    return { ok, status: ok ? 200 : 401, json: async () => ({ ok, service: "resonantos-bridge" }) };
  };
  const root = document.querySelector("main");
  renderBridgeTargetSection(root);
  await tick();
  return { root, calls, writes: () => writes, probe: async () => {
    [...root.querySelectorAll("button")].find((button) => button.textContent === "Test connection").click();
    await tick();
    return calls.at(-1);
  } };
}

test("Test connection uses the effective token for the unchanged target without saving or filling it", async (t) => {
  const ui = await setup(t);
  assert.equal(ui.root.querySelector('[name="bridge-token"]').value, "");
  const call = await ui.probe();
  assert.equal(call.headers["X-ResonantOS-Bridge-Token"], token);
  assert.equal(ui.root.querySelector(".settings-health-grid").children[2].querySelector("strong").textContent, "Online");
  assert.equal(ui.root.querySelector('[name="bridge-token"]').value, "");
  assert.equal(ui.writes(), 0);
});

test("explicit test token wins over the effective token", async (t) => {
  const ui = await setup(t);
  ui.root.querySelector('[name="bridge-token"]').value = "explicit-fixture-token";
  assert.equal((await ui.probe()).headers["X-ResonantOS-Bridge-Token"], "explicit-fixture-token");
});

test("blank token does not reuse credentials for a changed origin or path", async (t) => {
  const ui = await setup(t);
  for (const target of ["http://example.test:47773", "http://127.0.0.1:47774", `${url}/other`]) {
    ui.root.querySelector('[name="bridge-url"]').value = target;
    assert.equal((await ui.probe()).headers["X-ResonantOS-Bridge-Token"], undefined);
  }
});

test("a trailing slash on the same target retains authentication", async (t) => {
  const ui = await setup(t);
  ui.root.querySelector('[name="bridge-url"]').value = `${url}/`;
  assert.equal((await ui.probe()).headers["X-ResonantOS-Bridge-Token"], token);
});
