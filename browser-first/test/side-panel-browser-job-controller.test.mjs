import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelBrowserJobController } from "../resonantos-side-panel-extension/src/lib/side-panel-browser-job-controller.js";

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
  assert.deepEqual(harness.events[0], ["hydrate"]);
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
  assert.equal(harness.getCurrentControlRun().pendingApproval.step.action, "click");
  assert.equal(harness.getPendingApproval().step.action, "click");
  assert.ok(harness.events.some((event) => event[0] === "activate-tab" && event[1] === "job-focus"));
  assert.ok(harness.events.some((event) => event[0] === "render-control"));
});
