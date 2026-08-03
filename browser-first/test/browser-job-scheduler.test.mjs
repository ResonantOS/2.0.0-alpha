import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserJobScheduler } from "../resonantos-side-panel-extension/src/lib/browser-job-scheduler.js";
import { createBrowserJobStore } from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";

function createHarness(initialJobs = [], options = {}) {
  const writes = [];
  const storageState = {
    activeBrowserJob: options.activeBrowserJob ?? "",
    browserJobs: initialJobs,
    jobMonitorCollapsed: true
  };
  const store = createBrowserJobStore({
    storage: {
      get: async () => storageState,
      set: async (payload) => {
        writes.push(payload);
        Object.assign(storageState, payload);
      }
    },
    storageKeys: {
      activeBrowserJob: "activeBrowserJob",
      browserJobs: "browserJobs",
      jobMonitorCollapsed: "jobMonitorCollapsed"
    },
    now: () => "2026-05-31T10:00:00.000Z"
  });
  const events = [];
  const scheduler = createBrowserJobScheduler({
    browserJobStore: store,
    maxConcurrent: options.maxConcurrent ?? 2,
    onJobFailed: async (jobId, error) => events.push(["failed", jobId, error instanceof Error ? error.message : String(error)]),
    onJobFinished: async (jobId, result) => events.push(["finished", jobId, result]),
    onJobStarted: async (job) => events.push(["started", job.id]),
    runJob: async (job) => {
      events.push(["run", job.id, job.pageLock?.siteKey ?? "none"]);
      if (options.failJobId === job.id) throw new Error(`boom ${job.id}`);
      return { ok: true, id: job.id };
    }
  });
  return { events, scheduler, store, writes };
}

test("browser job scheduler starts multiple non-conflicting queued jobs", async () => {
  const harness = createHarness([
    { id: "job-a", goal: "Read docs", status: "queued", pageLock: { tabId: 1, siteKey: "docs.example", url: "https://docs.example/" } },
    { id: "job-b", goal: "Search shop", status: "queued", pageLock: { tabId: 2, siteKey: "shop.example", url: "https://shop.example/" } }
  ], { maxConcurrent: 2 });
  await harness.store.hydrate();

  const result = await harness.scheduler.tick();
  await Promise.all(harness.scheduler.activeJobIds().map(() => Promise.resolve()));

  assert.deepEqual(result.startedJobs.map((job) => job.id), ["job-a", "job-b"]);
  assert.deepEqual(harness.events.filter((event) => event[0] === "run").map((event) => event[1]), ["job-a", "job-b"]);
  assert.equal(harness.store.findJob("job-a").status, "completed");
  assert.equal(harness.store.findJob("job-b").status, "completed");
});

test("browser job scheduler single-flights concurrent ticks", async () => {
  let release;
  let executions = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness([
    { id: "job-once", goal: "Run once", status: "queued", pageLock: { tabId: 1, siteKey: "once.example" } }
  ], { maxConcurrent: 1 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 1,
    runJob: async () => {
      executions += 1;
      await gate;
      return { ok: true };
    }
  });
  await harness.store.hydrate();

  const first = harness.scheduler.tick();
  const second = harness.scheduler.tick();
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(firstResult.startedJobs.map((job) => job.id), ["job-once"]);
  assert.deepEqual(secondResult.startedJobs.map((job) => job.id), ["job-once"]);
  assert.equal(executions, 1);
});

test("browser job scheduler does not steal focus when starting background queued jobs", async () => {
  let releaseQueued;
  const gate = new Promise((resolve) => {
    releaseQueued = resolve;
  });
  const harness = createHarness([
    { id: "job-focused", goal: "Focused task", status: "running", pageLock: { tabId: 1, siteKey: "focused.example" } },
    { id: "job-background", goal: "Background task", status: "queued", pageLock: { tabId: 2, siteKey: "background.example" } }
  ], { activeBrowserJob: "job-focused", maxConcurrent: 2 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 2,
    onJobStarted: async (job) => harness.events.push(["started", job.id]),
    runJob: async (job) => {
      harness.events.push(["run", job.id]);
      await gate;
      return { ok: true };
    }
  });
  await harness.store.hydrate();

  const result = await harness.scheduler.tick();

  assert.deepEqual(result.startedJobs.map((job) => job.id), ["job-background"]);
  assert.equal(harness.store.getActiveJobId(), "job-focused");

  releaseQueued();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("browser job scheduler focuses first queued job only when no active focus exists", async () => {
  let releaseQueued;
  const gate = new Promise((resolve) => {
    releaseQueued = resolve;
  });
  const harness = createHarness([
    { id: "job-a", goal: "A", status: "queued", pageLock: { tabId: 1, siteKey: "a.example" } },
    { id: "job-b", goal: "B", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } }
  ], { maxConcurrent: 2 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 2,
    runJob: async () => {
      await gate;
      return { ok: true };
    }
  });
  await harness.store.hydrate();

  await harness.scheduler.tick();

  assert.equal(harness.store.getActiveJobId(), "job-a");

  releaseQueued();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("browser job scheduler leaves lock-conflicting queued jobs untouched", async () => {
  const harness = createHarness([
    { id: "running-a", goal: "Use DAO", status: "running", pageLock: { tabId: 1, siteKey: "dao.example", url: "https://dao.example/" } },
    { id: "queued-locked", goal: "Vote DAO", status: "queued", pageLock: { tabId: 2, siteKey: "dao.example", url: "https://dao.example/vote" } },
    { id: "queued-open", goal: "Read docs", status: "queued", pageLock: { tabId: 3, siteKey: "docs.example", url: "https://docs.example/" } }
  ], { maxConcurrent: 2 });
  await harness.store.hydrate();

  const result = await harness.scheduler.tick();

  assert.deepEqual(result.startedJobs.map((job) => job.id), ["queued-open"]);
  assert.equal(harness.store.findJob("queued-locked").status, "queued");
  assert.equal(harness.store.findJob("queued-open").status, "running");
});

test("browser job scheduler respects capacity", async () => {
  const harness = createHarness([
    { id: "job-a", goal: "A", status: "queued", pageLock: { tabId: 1, siteKey: "a.example" } },
    { id: "job-b", goal: "B", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } },
    { id: "job-c", goal: "C", status: "queued", pageLock: { tabId: 3, siteKey: "c.example" } }
  ], { maxConcurrent: 2 });
  await harness.store.hydrate();

  const result = await harness.scheduler.tick();

  assert.deepEqual(result.startedJobs.map((job) => job.id), ["job-a", "job-b"]);
  assert.equal(harness.store.findJob("job-c").status, "queued");
});

test("browser job scheduler marks failed executions without cancelling other jobs", async () => {
  const harness = createHarness([
    { id: "job-a", goal: "A", status: "queued", pageLock: { tabId: 1, siteKey: "a.example" } },
    { id: "job-b", goal: "B", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } }
  ], { failJobId: "job-a", maxConcurrent: 2 });
  await harness.store.hydrate();

  await harness.scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.store.findJob("job-a").status, "failed");
  assert.match(harness.store.findJob("job-a").lastError, /boom job-a/);
  assert.equal(harness.store.findJob("job-b").status, "completed");
  assert.ok(harness.events.some((event) => event[0] === "failed" && event[1] === "job-a"));
  assert.ok(harness.events.some((event) => event[0] === "finished" && event[1] === "job-b"));
});

test("browser job scheduler does not convert blocked control results into completed jobs", async () => {
  const harness = createHarness([
    { id: "job-a", goal: "A", status: "queued", pageLock: { tabId: 1, siteKey: "a.example" } },
    { id: "job-b", goal: "B", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } }
  ], { maxConcurrent: 2 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 2,
    onJobFinished: async (jobId, result) => harness.events.push(["finished", jobId, result]),
    runJob: async (job) => {
      harness.events.push(["run", job.id]);
      return job.id === "job-a"
        ? { ok: false, approvalRequired: false, status: "blocked" }
        : { ok: true };
    }
  });
  await harness.store.hydrate();

  await harness.scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.store.findJob("job-a").status, "blocked");
  assert.equal(harness.store.findJob("job-b").status, "completed");
  assert.ok(harness.events.some((event) => event[0] === "finished" && event[1] === "job-a" && event[2]?.status === "blocked"));
});

test("browser job scheduler auto-drains queued jobs when capacity opens", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const harness = createHarness([
    { id: "job-a", goal: "A", status: "queued", pageLock: { tabId: 1, siteKey: "a.example" } },
    { id: "job-b", goal: "B", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } }
  ], { maxConcurrent: 1 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 1,
    onJobStarted: async (job) => harness.events.push(["started", job.id]),
    onJobFinished: async (jobId) => harness.events.push(["finished", jobId]),
    runJob: async (job) => {
      harness.events.push(["run", job.id]);
      if (job.id === "job-a") await firstGate;
      return { ok: true, id: job.id };
    }
  });
  harness.scheduler.start();
  await harness.store.hydrate();

  await harness.scheduler.tick();
  assert.equal(harness.store.findJob("job-a").status, "running");
  assert.equal(harness.store.findJob("job-b").status, "queued");

  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.events.filter((event) => event[0] === "run").map((event) => event[1]), ["job-a", "job-b"]);
  assert.equal(harness.store.findJob("job-b").status, "completed");
});

test("browser job scheduler preserves paused and cancelled jobs when execution notices stop state", async () => {
  const harness = createHarness([
    { id: "job-paused", goal: "Pause", status: "queued", pageLock: { tabId: 1, siteKey: "pause.example" } },
    { id: "job-cancelled", goal: "Cancel", status: "queued", pageLock: { tabId: 2, siteKey: "cancel.example" } }
  ], { maxConcurrent: 2 });
  harness.scheduler = createBrowserJobScheduler({
    browserJobStore: harness.store,
    maxConcurrent: 2,
    onJobFailed: async (jobId) => harness.events.push(["failed", jobId]),
    onJobFinished: async (jobId) => harness.events.push(["finished", jobId]),
    onJobStarted: async (job) => harness.events.push(["started", job.id]),
    runJob: async (job) => {
      const status = job.id === "job-paused" ? "paused" : "cancelled";
      await harness.store.updateJob(job.id, { status });
      throw new Error(`job ${status}`);
    }
  });
  harness.scheduler.start();
  await harness.store.hydrate();

  await harness.scheduler.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.store.findJob("job-paused").status, "paused");
  assert.equal(harness.store.findJob("job-cancelled").status, "cancelled");
  assert.equal(harness.events.some((event) => event[0] === "failed"), false);
});
