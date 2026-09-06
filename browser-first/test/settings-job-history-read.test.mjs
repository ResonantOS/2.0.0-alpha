import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderBrowserControlSection } from "../resonantos-side-panel-extension/src/lib/settings/browser-control-section.js";

async function until(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Settings did not settle");
}

function setup(t, options) {
  const dom = new JSDOM("<main></main>", { url: "https://example.test" });
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const container = document.querySelector("main");
  renderBrowserControlSection(container, {
    chromeApi: { tabs: { query: async () => [] } },
    ...options
  });
  return {
    container,
    status: container.querySelector(".settings-status"),
    button: (label) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)
  };
}

for (const failure of ["read", "malformed", "write"]) {
  test(`clearing history preserves records on ${failure} failure and supports retry`, async (t) => {
    const original = [{ id: "active", status: "running" }, { id: "done", status: "completed" }];
    let records = structuredClone(original);
    let failing = false;
    let writes = 0;
    const ui = setup(t, {
      storageKeys: { browserJobs: "jobs" },
      storage: {
        async get() {
          if (failing && failure === "read") throw new Error("Cannot read jobs");
          return { jobs: failing && failure === "malformed" ? { unexpected: true } : structuredClone(records) };
        },
        async set(value) {
          writes += 1;
          if (failing && failure === "write") throw new Error("Cannot save jobs");
          records = structuredClone(value.jobs);
        }
      }
    });
    await until(() => ui.status.dataset.tone === "success");
    failing = true;
    ui.button("Clear Completed Browser Jobs").click();
    await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
    assert.deepEqual(records, original);
    assert.equal(writes, failure === "write" ? 1 : 0);
    assert.equal(ui.status.dataset.tone, "error");
    failing = false;
    ui.button("Clear Completed Browser Jobs").click();
    await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
    assert.deepEqual(records, [original[0]]);
    assert.equal(ui.status.dataset.tone, "success");
  });
}

test("only terminal records are removed and duplicate pending clears are ignored", async (t) => {
  const statuses = ["running", "queued", "waiting-approval", "unknown", "completed", "blocked", "denied", "cancelled", "failed"];
  let records = statuses.map((status) => ({ id: status, status }));
  let release;
  let pending = false;
  let reads = 0;
  const ui = setup(t, {
    storageKeys: { browserJobs: "jobs" },
    storage: {
      async get() {
        reads += 1;
        if (pending) await new Promise((resolve) => { release = resolve; });
        return { jobs: structuredClone(records) };
      },
      async set(value) { records = value.jobs; }
    }
  });
  await until(() => ui.status.dataset.tone === "success");
  pending = true;
  const button = ui.button("Clear Completed Browser Jobs");
  const before = reads;
  button.click();
  button.dispatchEvent(new button.ownerDocument.defaultView.Event("click"));
  assert.equal(reads, before + 1);
  pending = false;
  release();
  await until(() => !button.disabled);
  assert.deepEqual(records.map((job) => job.status), statuses.slice(0, 4));
});

test("missing storage cannot report a successful clear", async (t) => {
  const ui = setup(t, { storageKeys: { browserJobs: "jobs" } });
  await until(() => ui.status.dataset.tone === "success");
  ui.button("Clear Completed Browser Jobs").click();
  await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
  assert.equal(ui.status.dataset.tone, "error");
});
