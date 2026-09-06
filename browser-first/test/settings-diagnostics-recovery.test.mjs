import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { renderDiagnosticsSection } from "../resonantos-side-panel-extension/src/lib/settings/diagnostics-section.js";

async function setup(t, request) {
  const dom = new JSDOM("<main></main>");
  globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); delete globalThis.document; });
  const root = document.querySelector("main");
  renderDiagnosticsSection(root, { bridgeRequest: request });
  await setImmediate();
  return { root, values: () => [...root.querySelectorAll(".settings-diagnostics-health strong")].map((node) => node.textContent),
    retry: () => [...root.querySelectorAll("button")].find((node) => node.textContent === "Retry unavailable checks") };
}
const ready = { ok: true, status: "ready", providers: [], addons: [] };

test("a pending endpoint does not block completed services or the browser diagnostic request", async (t) => {
  let finish;
  const calls = [];
  const ui = await setup(t, async (route) => {
    calls.push(route);
    if (route === "/memory/status") return new Promise((resolve) => { finish = resolve; });
    return ready;
  });
  try {
    assert.equal(calls.length, 5);
    assert.deepEqual(ui.values(), ["Ready", "Ready", "Ready", "Checking", "Ready"]);
    assert.match(ui.root.querySelector(".settings-status").textContent, /1.*endpoint/);
  } finally {
    finish(ready);
    await setImmediate();
  }
});

test("a timed-out endpoint aborts, offers retry, and ignores its late completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishOld;
  let signal;
  let memoryCalls = 0;
  const calls = [];
  const ui = await setup(t, async (route, options) => {
    calls.push(route);
    if (route === "/memory/status" && ++memoryCalls === 1) {
      signal = options.signal;
      return new Promise((resolve) => { finishOld = resolve; });
    }
    return ready;
  });
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.equal(signal.aborted, true);
  assert.equal(ui.values()[3], "Error");
  assert.match(ui.root.textContent, /timed out/i);
  assert.equal(ui.retry().hidden, false);
  ui.retry().click(); ui.retry().click();
  await setImmediate();
  assert.equal(calls.length, 6);
  assert.equal(memoryCalls, 2);
  assert.deepEqual(ui.values(), ["Ready", "Ready", "Ready", "Ready", "Ready"]);
  assert.equal(ui.retry().hidden, true);
  finishOld({ ok: true, wiki: { pages: 999 } });
  await setImmediate();
  assert.doesNotMatch(ui.root.textContent, /999 pages/);
});

test("retry checks only failed endpoints and keeps successful results visible", async (t) => {
  let providerCalls = 0;
  let otherCalls = 0;
  const ui = await setup(t, async (route) => {
    if (route === "/providers/status") {
      if (++providerCalls === 1) throw Error("fixture provider unavailable");
    } else otherCalls++;
    return ready;
  });
  assert.deepEqual(ui.values(), ["Ready", "Error", "Ready", "Ready", "Ready"]);
  ui.retry().click(); await setImmediate();
  assert.equal(providerCalls, 2);
  assert.equal(otherCalls, 4);
  assert.equal(ui.retry().hidden, true);
  assert.equal(ui.root.querySelector(".settings-status").getAttribute("role"), "status");
});
