import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderMemorySection } from "../resonantos-side-panel-extension/src/lib/settings/memory-section.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(t, request) {
  const dom = new JSDOM("<main></main>");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  globalThis.document = dom.window.document;
  t.after(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  const root = document.querySelector("main");
  renderMemorySection(root, { bridgeRequest: request });
  await tick();
  const path = root.querySelector('[name="path"]');
  path.value = "/fixture/source";
  return { root, path, status: root.querySelector(".settings-status"),
    save: [...root.querySelectorAll("button")].find((button) => button.textContent === "Connect Source"),
    retry: () => [...root.querySelectorAll("button")].find((button) => button.textContent === "Retry refresh"),
    submit: () => root.querySelector("form").dispatchEvent(new dom.window.Event("submit", { cancelable: true })) };
}
const empty = { settings: { sources: [], syncMode: "manual-review" } };

test("successful write followed by failed refresh reports saved and retries reads only", async (t) => {
  let writes = 0;
  let failRefresh = true;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; return { ok: true }; }
    if (writes && failRefresh) throw Error("temporary refresh failure");
    return empty;
  });
  ui.submit();
  await tick();
  assert.equal(writes, 1);
  assert.match(ui.status.textContent, /saved.*refresh/i);
  assert.doesNotMatch(ui.status.textContent, /Save failed/);
  assert.equal(ui.status.dataset.tone, "warning");
  assert.equal(ui.path.value, "");
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.retry().hidden, false);
  assert.equal(ui.retry().getAttribute("aria-label"), "Refresh Memory settings");
  assert.equal(ui.root.querySelector(`#${ui.retry().getAttribute("aria-describedby")}`), ui.status);
  ui.retry().click();
  await tick();
  assert.equal(ui.retry().hidden, false);
  assert.equal(writes, 1);
  failRefresh = false;
  ui.retry().click();
  await tick();
  assert.equal(writes, 1);
  assert.equal(ui.retry().hidden, true);
  assert.equal(ui.status.textContent, "Memory settings refreshed.");
});

test("rejected write retains source input and retry distinguishes a saved write from failed refresh", async (t) => {
  let writes = 0;
  let reads = 0;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { if (++writes === 1) throw Error("write unavailable"); return { ok: true }; }
    reads++;
    if (writes === 2) throw Error("refresh unavailable after retry");
    return empty;
  });
  ui.submit(); await tick();
  assert.match(ui.status.textContent, /Save failed: write unavailable/);
  assert.equal(ui.path.value, "/fixture/source");
  assert.equal(reads, 1);
  assert.equal(ui.save.disabled, false);
  ui.submit(); await tick();
  assert.equal(writes, 2);
  assert.equal(ui.path.value, "");
  assert.equal(ui.status.dataset.tone, "warning");
  assert.match(ui.status.textContent, /saved.*refresh unavailable after retry/);
  assert.doesNotMatch(ui.status.textContent, /Save failed/);
  assert.equal(ui.retry().hidden, false);
});

test("pending save ignores duplicate submits", async (t) => {
  let finish;
  let writes = 0;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; await new Promise((resolve) => { finish = resolve; }); }
    return empty;
  });
  ui.submit(); ui.submit();
  assert.equal(writes, 1);
  assert.equal(ui.save.disabled, true);
  finish(); await tick();
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.status.textContent, "Memory settings saved.");
});

test("pending refresh retry blocks another write and shows the refreshed source", async (t) => {
  let writes = 0;
  let refreshes = 0;
  let finish;
  const ui = await setup(t, async (_route, options) => {
    if (options.method === "POST") { writes++; return { ok: true }; }
    if (!writes) return empty;
    if (++refreshes === 1) throw Error("refresh unavailable");
    return new Promise((resolve) => { finish = resolve; });
  });
  ui.submit(); await tick();
  ui.retry().click();
  assert.equal(ui.retry().disabled, true);
  assert.equal(ui.save.disabled, true);
  ui.submit(); ui.retry().click();
  assert.equal(writes, 1);
  assert.equal(refreshes, 2);
  finish({ settings: { sources: [{ id: "fixture-source", path: "/fixture/source", enabled: true }], syncMode: "manual-review" } });
  await tick();
  assert.match(ui.root.querySelector(".settings-control-list").textContent, /fixture\/source/);
  assert.equal(ui.retry().hidden, true);
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.status.getAttribute("role"), "status");
});
