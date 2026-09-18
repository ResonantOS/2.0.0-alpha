import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserJobStore, normalizeBrowserJob } from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";
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

for (const failure of ["read", "malformed", "missing", "write"]) {
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
          if (failing && failure === "missing") return {};
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
    assert.deepEqual(records, [normalizeBrowserJob(original[0], { now: () => records[0].updatedAt })]);
    assert.equal(ui.status.dataset.tone, "success");
  });
}

test("Settings clear with a single-key adapter preserves running records and focus", async (t) => {
  const running = normalizeBrowserJob({ id: "running", status: "running" }, {
    now: () => "2026-05-26T10:00:00.000Z"
  });
  const data = { jobs: [running], active: "running" };
  const ui = setup(t, {
    storageKeys: { browserJobs: "jobs", activeBrowserJob: "active" },
    storage: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(value) { Object.assign(data, structuredClone(value)); }
    }
  });
  await until(() => ui.status.dataset.tone === "success");
  const clear = async () => {
    ui.button("Clear Completed Browser Jobs").click();
    await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
    assert.deepEqual(data, { jobs: [running], active: "running" });
    assert.equal(ui.status.dataset.tone, "success");
  };
  await clear();
  data.jobs.push({ id: "completed", status: "completed" });
  await clear();
});

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
  assert.deepEqual(records.map((job) => job.id), statuses.slice(0, 4));
  assert.deepEqual(records.map((job) => job.status), ["running", "queued", "paused", "paused"]);
});

test("missing storage cannot report a successful clear", async (t) => {
  const ui = setup(t, { storageKeys: { browserJobs: "jobs" } });
  await until(() => ui.status.dataset.tone === "success");
  ui.button("Clear Completed Browser Jobs").click();
  await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
  assert.equal(ui.status.dataset.tone, "error");
});

test("Settings clear selects five original terminal statuses and sanitizes fresh survivors", async (t) => {
  const data = { jobs: [{ id: "displayed", status: "running" }], active: "displayed" }; const writes = [];
  const storageKeys = { browserJobs: "jobs", activeBrowserJob: "active", jobMonitorCollapsed: "collapsed" };
  const storage = { async get() { return structuredClone(data); }, async set(value) {
    writes.push(value); Object.assign(data, structuredClone(value));
  } };
  const ui = setup(t, { storage, storageKeys });
  await until(() => ui.status.dataset.tone === "success");
  const statuses = ["completed", "blocked", "denied", "cancelled", "failed", "running", "unknown"];
  data.jobs = statuses.map((status) => ({ id: status, status, goal: 'client_secret="private"' }));
  const boundaryPrefix = "ordinary ".repeat(33).slice(0, 291) + " ";
  data.jobs.find((job) => job.id === "running").goal = boundaryPrefix + "ghp_" + "x".repeat(24);
  data.active = "completed";
  ui.button("Clear Completed Browser Jobs").click();
  await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
  assert.deepEqual(data.jobs.map((job) => job.id), ["running", "unknown"]);
  assert.deepEqual(data.jobs.map((job) => job.status), ["running", "paused"]);
  assert.equal(data.active, null); assert.equal(writes.length, 1);
  assert.equal(data.jobs[0].goal, boundaryPrefix + "[REDACTE");
  assert.equal(data.jobs[1].goal, 'client_secret="REDACTED"');
  assert.match(ui.container.textContent, /completed, blocked, denied, cancelled, and failed/);
  data.active = "running";
  ui.button("Clear Completed Browser Jobs").click();
  await until(() => !ui.button("Clear Completed Browser Jobs").disabled);
  assert.equal(data.active, "running"); assert.equal(Object.hasOwn(writes.at(-1), "active"), false);

  // Explicit, descending updatedAt values: hydration sorts newest first, so the
  // surviving order below is deterministic instead of depending on how many
  // milliseconds the seeding loop happens to straddle.
  data.jobs = statuses.slice(0, 5).map((status, index) => ({
    id: status,
    status,
    updatedAt: new Date(Date.UTC(2026, 8, 17, 12, 0, 30 - index)).toISOString()
  }));
  data.active = "completed";
  const store = createBrowserJobStore({ storage, storageKeys }); await store.hydrate();
  await store.clearCompletedJobs();
  assert.deepEqual(store.getJobs().map((job) => job.id), ["completed", "blocked", "failed"],
    "side-panel clear preserves focused, blocked and failed jobs");
});
