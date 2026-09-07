import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderAddonsSection } from "../resonantos-side-panel-extension/src/lib/settings/addons-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(t, request) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const root = document.querySelector("main");
  renderAddonsSection(root, { bridgeRequest: request });
  await tick();
  return { root, status: root.querySelector(".settings-status"),
    toggle: () => root.querySelector(".settings-addon-execution button"),
    retry: () => [...root.querySelectorAll("button")].find((button) => button.textContent === "Refresh execution state") };
}
const snapshot = (enabled) => ({ addons: [{ id: "addon.hermes", name: "Hermes", available: true, execution: { localCliExecution: enabled } }] });

test("an uncertain write response shows the actual changed host state without repeating the write", async (t) => {
  let enabled = true;
  let writes = 0;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") {
      writes++;
      enabled = false;
      throw Error("response unavailable");
    }
    return snapshot(enabled);
  });
  ui.toggle().click(); await tick();
  assert.equal(writes, 1);
  assert.match(ui.status.textContent, /request failed/);
  assert.equal(ui.toggle().textContent, "Enable local execution");
});

test("rejected execution change reports failure and refreshes the actual state for retry", async (t) => {
  let enabled = true;
  let writes = 0;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") {
      if (++writes === 1) throw Error("fixture write unavailable");
      enabled = options.body.localCliExecution;
    }
    return snapshot(enabled);
  });
  ui.toggle().click(); await tick();
  assert.match(ui.status.textContent, /failed.*fixture write unavailable/i);
  assert.equal(ui.toggle().textContent, "Disable local execution");
  assert.equal(ui.toggle().disabled, false);
  ui.toggle().click(); await tick();
  assert.equal(writes, 2);
  assert.equal(enabled, false);
  assert.equal(ui.toggle().textContent, "Enable local execution");
});

test("successful write followed by failed status refresh offers a read-only recovery", async (t) => {
  let writes = 0;
  let failRead = true;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; return { ok: true }; }
    if (writes && failRead) throw Error("fixture refresh unavailable");
    return snapshot(!writes);
  });
  ui.toggle().click(); await tick();
  assert.equal(writes, 1);
  assert.match(ui.status.textContent, /saved.*could not.*confirm/i);
  assert.equal(ui.toggle().disabled, true);
  assert.equal(ui.retry().hidden, false);
  failRead = false;
  ui.retry().click(); await tick();
  assert.equal(writes, 1);
  assert.equal(ui.retry().hidden, true);
  assert.equal(ui.toggle().textContent, "Enable local execution");
  assert.equal(ui.toggle().disabled, false);
});

test("pending execution write disables controls and prevents duplicate submission", async (t) => {
  let writes = 0;
  let finish;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; await new Promise((resolve) => { finish = resolve; }); }
    return snapshot(!writes);
  });
  ui.toggle().click(); ui.toggle().click();
  assert.equal(writes, 1);
  assert.equal(ui.toggle().disabled, true);
  finish(); await tick();
  assert.equal(ui.toggle().disabled, false);
  assert.equal(ui.status.getAttribute("role"), "status");
});

test("failed write and failed refresh leave execution state unconfirmed until a read succeeds", async (t) => {
  let writes = 0;
  let failRead = true;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; throw Error("write unavailable"); }
    if (writes && failRead) throw Error("read unavailable");
    return snapshot(true);
  });
  ui.toggle().click(); await tick();
  assert.match(ui.status.textContent, /failed/i);
  assert.match(ui.status.textContent, /write unavailable/);
  assert.match(ui.status.textContent, /read unavailable/);
  assert.equal(ui.toggle().disabled, true);
  ui.retry().click(); await tick();
  assert.equal(ui.retry().hidden, false);
  assert.equal(writes, 1);
  failRead = false;
  ui.retry().click(); await tick();
  assert.equal(ui.toggle().textContent, "Disable local execution");
  assert.equal(ui.toggle().disabled, false);
});
