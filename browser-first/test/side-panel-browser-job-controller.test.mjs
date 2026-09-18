import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelBrowserJobController } from "../resonantos-side-panel-extension/src/lib/side-panel-browser-job-controller.js";

import { createBrowserJobStore, normalizeBrowserJob } from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";
import { createSidePanelControlCommandController } from "../resonantos-side-panel-extension/src/lib/side-panel-control-command-controller.js";

function createStore({ recovered = [], focusedJob = null } = {}) {
  const events = [];
  const jobs = [];
  return {
    events,
    jobs,
    async activateJob(jobId) {
      events.push(["activate", jobId]);
      return focusedJob?.id === jobId ? focusedJob : jobs.find((job) => job.id === jobId) ?? null;
    },
    async createJob(job) {
      const created = {
        id: `job-${jobs.length + 1}`,
        ...job
      };
      jobs.push(created);
      events.push(["create", created]);
      return created;
    },
    async hydrate() {
      events.push(["hydrate"]);
    },
    async recoverInterruptedJobs(request) {
      events.push(["recover", request]);
      return recovered;
    },
    async updateJob(jobId, patch) {
      events.push(["update", jobId, patch]);
      const existingIndex = jobs.findIndex((job) => job.id === jobId);
      if (existingIndex >= 0) {
        jobs[existingIndex] = { ...jobs[existingIndex], ...patch };
        return jobs[existingIndex];
      }
      return { id: jobId, ...patch };
    }
  };
}

function createHarness(store = createStore()) {
  const events = store.events;
  let currentControlRun = { id: "previous-run" };
  let pendingApproval = null;
  let nextDecision = { id: "decision-1", mode: "approved-once" };
  const controller = createSidePanelBrowserJobController({
    activateJobTab: async (job) => events.push(["activate-tab", job.id]),
    addMessage: async (role, content) => events.push(["message", role, content]),
    browserJobStore: store,
    consumeNextControlPreflightDecision: () => {
      const decision = nextDecision;
      nextDecision = null;
      return decision;
    },
    getCurrentControlRun: () => currentControlRun,
    prepareBrowserJobPageLock: async ({ goal, status }) => ({
      type: "tab",
      tabId: 42,
      siteKey: "example.com",
      reason: `${status}:${goal}`
    }),
    renderControlMonitor: () => events.push(["render-control"]),
    renderJobMonitor: () => events.push(["render-jobs"]),
    setCurrentControlRun: (run) => {
      currentControlRun = run;
    },
    setPendingApproval: (approval) => {
      pendingApproval = approval;
    }
  });
  return {
    controller,
    events,
    getCurrentControlRun: () => currentControlRun,
    getPendingApproval: () => pendingApproval,
    store
  };
}

test("side panel browser job controller recovers interrupted jobs and announces them", async () => {
  const store = createStore({
    recovered: [{ id: "job-a" }, { id: "job-b" }]
  });
  const harness = createHarness(store);

  const recovered = await harness.controller.loadBrowserJobs();

  assert.equal(recovered.length, 2);
  assert.deepEqual(harness.events.slice(0, 2), [["render-jobs"], ["hydrate"]]);
  assert.equal(harness.events.some((event) => event[0] === "render-jobs"), true);
  assert.ok(harness.events.some((event) => event[0] === "message" && /Recovered 2 interrupted browser jobs/.test(event[2])));
});

test("side panel browser job controller creates queued jobs with page lock and preflight decision", async () => {
  const harness = createHarness();

  const job = await harness.controller.createBrowserJob({
    goal: "research current AI browser news",
    planner: "observe-act-verify-loop",
    summary: "Queued browser-agent loop.",
    status: "queued"
  });

  assert.equal(job.id, "job-1");
  assert.equal(job.activate, false);
  assert.equal(job.pageLock.siteKey, "example.com");
  assert.equal(job.preflightDecision.mode, "approved-once");
  assert.equal(harness.events.some((event) => event[0] === "render-jobs"), true);
});

test("side panel browser job controller resumes existing jobs without dropping prior decision", async () => {
  const harness = createHarness();
  const existingJob = {
    id: "job-existing",
    preflightDecision: { id: "prior", mode: "resumed" }
  };

  const job = await harness.controller.createBrowserJob({
    existingJob,
    goal: "continue shopping task",
    status: "running"
  });

  assert.equal(job.id, "job-existing");
  assert.deepEqual(
    harness.events.find((event) => event[0] === "update").slice(1),
    ["job-existing", {
      allowHumanStopOverride: true,
      status: "running",
      planner: "observe-act-verify-loop",
      summary: "",
      pageLock: {
        type: "tab",
        tabId: 42,
        siteKey: "example.com",
        reason: "running:continue shopping task"
      },
      preflightDecision: { id: "decision-1", mode: "approved-once" }
    }]
  );
});

test("side panel browser job controller focuses jobs into current control run state", async () => {
  const focusedJob = {
    artifacts: [{ type: "report" }],
    createdAt: "2026-06-01T00:00:00.000Z",
    goal: "find booking slot",
    id: "job-focus",
    pageLock: { tabId: 42 },
    pendingApproval: { step: { action: "click" } },
    planner: "observe-act-verify-loop",
    status: "approval",
    steps: [{ label: "Read page" }],
    summary: "Needs approval",
    timing: { startedAt: "2026-06-01T00:00:01.000Z" }
  };
  const harness = createHarness(createStore({ focusedJob }));

  const result = await harness.controller.focusBrowserJobRun("job-focus");

  assert.equal(result.id, "job-focus");
  assert.equal(harness.getCurrentControlRun().goal, "find booking slot");
  assert.equal(harness.getPendingApproval().step.action, "click");
  assert.ok(harness.events.some((event) => event[0] === "activate-tab" && event[1] === "job-focus"));
  assert.ok(harness.events.some((event) => event[0] === "render-control"));
});

const historyFailureMessage = "Browser job history could not be loaded. No browser job was started.";
function createHistoryHarness(prepare = async () => null) {
  const now = () => "2026-05-26T10:00:00.000Z";
  const saved = normalizeBrowserJob({ id: "saved", goal: "Read the current page", status: "paused" }, { now });
  const backing = { jobs: [saved], active: saved.id, collapsed: true };
  const writes = [];
  const events = [];
  let failRead = false;
  let allocated = 0;
  const store = createBrowserJobStore({
    storageKeys: { browserJobs: "jobs", activeBrowserJob: "active", jobMonitorCollapsed: "collapsed" },
    now, createId: () => `new-${++allocated}`,
    storage: {
      get: async () => { if (failRead) throw new Error("history read failed"); return structuredClone(backing); },
      set: async (value) => { writes.push(structuredClone(value)); Object.assign(backing, structuredClone(value)); }
    }
  });
  const controller = createSidePanelBrowserJobController({
    browserJobStore: store,
    prepareBrowserJobPageLock: async (request) => { events.push("prepare"); return prepare(request); },
    renderJobMonitor: () => events.push("render")
  });
  return { store, controller, backing, saved, writes, events, failRead: () => { failRead = true; }, allocated: () => allocated };
}

for (const resumed of [false, true]) {
  test(`failed history refuses fresh and resumed commands through the existing error boundary (${resumed ? "resumed" : "fresh"})`, async (t) => {
    const h = createHistoryHarness();
    const before = structuredClone(h.backing);
    h.failRead();
    await h.store.hydrate();
    const messages = [];
    let ticks = 0;
    t.mock.method(console, "error", () => undefined);
    const commands = createSidePanelControlCommandController({
      browserJobStore: h.store, createBrowserJob: h.controller.createBrowserJob,
      taskConsentStore: { consentFor: async () => null },
      activeTab: async () => ({ id: 42, url: "https://example.com" }),
      addMessage: async (role, content) => messages.push([role, content]),
      getBrowserJobScheduler: () => ({ tick: async () => { ticks++; } })
    });
    const result = await commands.runControlCommand("Read the current page", resumed ? { resumedFromJob: h.saved } : {});
    assert.equal(result, null, "failed history must refuse the command");
    assert.deepEqual(messages, [["system", `Agent Control could not start.\n${historyFailureMessage}`]]);
    assert.deepEqual(h.events, [], "refusal must precede page-lock preparation and rendering");
    assert.equal(ticks, 0);
    assert.equal(h.allocated(), 0);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.backing, before);
  });

  test(`admission observes history failure during page-lock preparation (${resumed ? "resumed" : "fresh"})`, { timeout: 2000 }, async (t) => {
    const preparation = Promise.withResolvers();
    t.after(() => preparation.resolve(null));
    const h = createHistoryHarness(() => preparation.promise);
    await h.store.hydrate();
    const existingJob = h.store.findJob("saved");
    const before = structuredClone(h.backing);
    const writesBefore = h.writes.length;
    const creation = h.controller.createBrowserJob({ goal: "Read the current page", existingJob: resumed ? existingJob : null });
    const rejected = assert.rejects(creation, { message: historyFailureMessage });
    assert.deepEqual(h.events, ["prepare"]);
    h.failRead();
    await h.store.hydrate();
    preparation.resolve(null);
    await rejected;
    assert.deepEqual(h.events, ["prepare"], "failed admission must not render success");
    assert.deepEqual(h.store.getJobs(), []);
    assert.equal(h.allocated(), 0);
    assert.equal(h.writes.length, writesBefore);
    assert.deepEqual(h.backing, before);
  });
}

test("failed-history approval and completion updates remain fulfilled", async () => {
  const h = createHistoryHarness();
  const before = structuredClone(h.backing);
  h.failRead();
  await h.store.hydrate();
  for (const patch of [
    { status: "approval", pendingApproval: { step: { type: "click", text: "Continue" } } },
    { status: "completed", completedAt: "2026-05-26T10:01:00.000Z" },
    { artifacts: [{ type: "report", title: "Saved result" }] },
    { steps: [{ type: "read", state: "completed", note: "Page read" }] }
  ]) assert.equal(await h.controller.updateBrowserJob("saved", patch), null);
  void h.controller.updateBrowserJob("saved", { summary: "Fire-and-forget completion" });
  await h.store.persist();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.writes.length, 0, "fulfilled background updates must not attempt storage writes");
  assert.deepEqual(h.backing, before);
});

test("failed hydration skips recovery and a coalesced retry restores history", { timeout: 2000 }, async (t) => {
  let failure = true;
  let preparationFailure = false;
  let pending;
  let reads = 0;
  const writes = [];
  const now = () => "2026-05-26T10:00:00.000Z";
  const saved = normalizeBrowserJob({ id: "saved", goal: "Read page", status: "running" }, { now });
  const backing = { jobs: [saved], active: "saved", collapsed: true };
  const store = createBrowserJobStore({ now,
    storageKeys: { browserJobs: "jobs", activeBrowserJob: "active", jobMonitorCollapsed: "collapsed" },
    storage: {
      async get() {
        reads++; if (pending) await pending.promise;
        if (failure) throw Error("private read failure");
        if (preparationFailure) return { jobs: [{ get id() { throw Error("private preparation failure"); } }] };
        return structuredClone(backing);
      },
      async set(value) { writes.push(structuredClone(value)); Object.assign(backing, structuredClone(value)); }
    }
  });
  let recoveries = 0;
  const recover = store.recoverInterruptedJobs;
  store.recoverInterruptedJobs = (...args) => { recoveries++; return recover(...args); };
  const states = [];
  const renders = [];
  const controller = createSidePanelBrowserJobController({ browserJobStore: store,
    onHistoryLoadStateChange: (state) => states.push(state),
    renderJobMonitor: () => renders.push(controller.getHistoryLoadState()) });
  assert.deepEqual(await controller.loadBrowserJobs(), []);
  assert.equal(controller.getHistoryLoadState(), "error");
  assert.deepEqual(states, ["loading", "error"]);
  assert.deepEqual(renders, ["loading", "error"]);
  assert.equal(store.isHistoryReadBlocked(), true);
  assert.equal(recoveries, 0);
  assert.equal(writes.length, 0);
  failure = false; preparationFailure = true;
  assert.deepEqual(await controller.loadBrowserJobs(), []);
  assert.equal(controller.getHistoryLoadState(), "error");
  assert.equal(store.isHistoryReadBlocked(), true);
  assert.equal(recoveries, 0);
  preparationFailure = false;
  pending = Promise.withResolvers(); t.after(() => pending.resolve());
  const before = reads;
  const first = controller.loadBrowserJobs();
  const second = controller.loadBrowserJobs();
  assert.equal(controller.getHistoryLoadState(), "loading");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, before + 1, "overlapping Retry performs one hydration");
  assert.equal(store.isHistoryReadBlocked(), true, "controller must not clear store latch");
  pending.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  assert.equal(recoveries, 1);
  assert.equal(controller.getHistoryLoadState(), "ready");
  assert.equal(store.isHistoryReadBlocked(), false);
  assert.equal(backing.jobs[0].status, "paused", "normal interrupted recovery is permitted");
  assert.equal(backing.collapsed, true);
  assert.equal(writes.length, 1, "only normal recovery writes this canonical fixture");
  await controller.loadBrowserJobs();
  assert.equal(reads, before + 2, "inflight reference clears after settlement");
});
