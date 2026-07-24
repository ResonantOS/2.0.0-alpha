import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelScheduledBrowserJobRunner } from "../resonantos-side-panel-extension/src/lib/side-panel-scheduled-browser-job-runner.js";

function createStore({ activeJobId = "job-a", jobs = [] } = {}) {
  const records = new Map(jobs.map((job) => [job.id, { ...job }]));
  const events = [];
  return {
    events,
    findJob(jobId) {
      return records.get(jobId) ?? null;
    },
    getActiveJobId() {
      return activeJobId;
    },
    setJob(job) {
      records.set(job.id, { ...job });
    },
    update(jobId, patch) {
      const current = records.get(jobId) ?? { id: jobId };
      const next = { ...current, ...patch };
      records.set(jobId, next);
      events.push(["store-update", jobId, patch]);
      return next;
    }
  };
}

function createHarness({ activeJobId = "job-a", jobs = [], runnerFactory = null } = {}) {
  const store = createStore({ activeJobId, jobs });
  const events = store.events;
  let controlledTabId = 1;
  let currentControlRun = null;
  let lastSnapshot = { title: "Existing", url: "https://example.com" };
  let pendingApproval = null;
  const runner = createSidePanelScheduledBrowserJobRunner({
    activateJobTab: async (job) => events.push(["activate-tab", job.id]),
    addMessage: async (role, content) => events.push(["message", role, content]),
    approvalBoundaryForStep: () => "safe",
    browserJobStore: store,
    chromeApi: {
      tabs: {
        async query() {
          return [
            { active: true, id: 10, title: "Readable", url: "https://example.com/page" },
            { active: false, id: 11, title: "Settings", url: "chrome://settings" }
          ];
        }
      }
    },
    controlStepLabel: (step) => step.label || step.type,
    createAgentControlRunnerFactory: runnerFactory ?? (() => ({
      async continueControlLoop() {
        return { ok: true };
      }
    })),
    executeControlStep: async (step) => {
      events.push(["execute-step", step.type, step.ref ?? ""]);
      return { ok: true, clickedText: step.text ?? "" };
    },
    getControlledTabId: () => controlledTabId,
    getCurrentControlRun: () => currentControlRun,
    getLastSnapshot: () => lastSnapshot,
    isReadableBrowserTab: (tab) => /^https?:\/\//.test(tab?.url ?? ""),
    readActivePage: async () => ({
      snapshot: {
        title: "Read page",
        url: "https://example.com/page",
        text: "Visible content"
      }
    }),
    renderControlMonitor: () => events.push(["render-control"]),
    renderJobMonitor: () => events.push(["render-jobs"]),
    requestNextControlAction: async (request) => {
      events.push(["next-action", Boolean(request.override)]);
      return { type: "done" };
    },
    saveBrowserJobReportToArchive: async (job) => {
      events.push(["save-report", job.id, job.status]);
      return { type: "archive-intake", path: "reports/job.md" };
    },
    setActivity: (...args) => events.push(["activity", ...args]),
    setControlledTabId: (tabId) => {
      controlledTabId = tabId;
      events.push(["controlled-tab", tabId]);
    },
    setCurrentControlRun: (run) => {
      currentControlRun = run;
      events.push(["current-run", run?.id ?? ""]);
    },
    setLastSnapshot: (snapshot) => {
      lastSnapshot = snapshot;
      events.push(["snapshot", snapshot?.title ?? null]);
    },
    setPageControlOverlay: async (...args) => events.push(["overlay", ...args]),
    setPendingApproval: (approval) => {
      pendingApproval = approval;
      events.push(["approval", approval?.step?.type ?? "none"]);
    },
    setStatus: (status) => events.push(["status", status]),
    sleep: async () => undefined,
    taskConsentStore: {
      async consentFor(request) {
        events.push(["consent-for", request.siteKey, request.goal]);
        return null;
      }
    },
    updateBrowserJob: async (jobId, patch) => store.update(jobId, patch),
    windowRef: {
      __resonantosNextActionOverride: () => ({ type: "done" })
    },
    withBrowserActionLock: async (task) => {
      events.push(["lock"]);
      return task();
    }
  });
  return {
    events,
    getPendingApproval: () => pendingApproval,
    runner,
    store
  };
}

test("scheduled browser job runner observes locked job page with readable tab context", async () => {
  const harness = createHarness();

  const snapshot = await harness.runner.observeQueuedJobPage({
    goal: "read the page",
    id: "job-a"
  });

  assert.equal(snapshot.title, "Read page");
  assert.equal(snapshot.tabs.length, 1);
  assert.equal(snapshot.tabs[0].controlled, false);
  assert.deepEqual(harness.events.slice(0, 3), [
    ["lock"],
    ["activate-tab", "job-a"],
    ["activity", "reading", "Observing job page", "read the page"]
  ]);
});

test("scheduled browser job runner blocks queued execution for paused jobs", async () => {
  const harness = createHarness({
    jobs: [{ id: "job-paused", status: "paused" }]
  });

  await assert.rejects(
    () => harness.runner.executeQueuedJobStep({ id: "job-paused" }, { type: "click" }),
    /job-paused is paused/
  );
});

test("scheduled browser job runner delegates scheduled work through injected Agent Control runner", async () => {
  let capturedDeps = null;
  const harness = createHarness({
    jobs: [{ id: "job-a", status: "running" }],
    runnerFactory: (deps) => {
      capturedDeps = deps;
      return {
        async continueControlLoop(request) {
          deps.startControlRun({
            goal: request.goal,
            plan: {
              source: "observe-act-verify-loop",
              summary: "Running",
              steps: [],
              artifacts: []
            }
          });
          const index = deps.appendControlStep({ type: "click", text: "Continue" });
          await deps.executeControlStep({ type: "click", text: "Continue", ref: "btn-continue" });
          deps.updateControlStep(index, "completed", "Clicked Continue", { verificationChanged: true });
          deps.setPendingApproval({ step: { type: "click" }, reason: "review" });
          deps.finishControlRun("completed", { type: "report", path: "reports/job-a.md" });
          return { ok: true, request };
        }
      };
    }
  });

  const result = await harness.runner.runScheduledBrowserJob({
    goal: "complete a safe task",
    id: "job-a",
    pageLock: { siteKey: "example.com", tabId: 10 },
    planner: "observe-act-verify-loop",
    status: "running",
    summary: "Queued",
    steps: []
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.ok, true);
  assert.equal(capturedDeps.getActiveJobId(), "job-a");
  assert.ok(harness.events.some((event) => event[0] === "message" && /Browser job job-a started/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "controlled-tab" && event[1] === 10));
  assert.ok(harness.events.some((event) => event[0] === "execute-step" && event[1] === "click"));
  assert.ok(harness.events.some((event) => event[0] === "overlay" && event[1] === false));
  assert.ok(harness.events.some((event) => event[0] === "store-update" && event[2].status === "completed"));
});

test("scheduled browser job runner durably persists an approval and page lock together", async () => {
  const approval = {
    step: { type: "click", text: "Details" },
    stepIndex: 0,
    reason: "Review this safe action.",
    results: [],
    history: []
  };
  const harness = createHarness({
    jobs: [{
      id: "job-a",
      goal: "open details",
      status: "running",
      pageLock: { siteKey: "example.com", tabId: 10 }
    }],
    runnerFactory: (deps) => ({
      async continueControlLoop() {
        deps.startControlRun({
          goal: "open details",
          plan: {
            source: "observe-act-verify-loop",
            summary: "Waiting for approval",
            pageLock: { siteKey: "example.com", tabId: 10 },
            steps: [{ type: "click", text: "Details", state: "blocked" }],
            artifacts: []
          }
        });
        deps.finishControlRun("approval", null, approval);
        return { ok: false, approvalRequired: true };
      }
    })
  });

  await harness.runner.runScheduledBrowserJob({
    goal: "open details",
    id: "job-a",
    pageLock: { siteKey: "example.com", tabId: 10 },
    planner: "observe-act-verify-loop",
    status: "running",
    summary: "Queued",
    steps: []
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const durable = harness.store.findJob("job-a");
  assert.equal(durable.status, "approval");
  assert.equal(durable.pendingApproval.step.text, "Details");
  assert.equal(durable.pendingApproval.stepIndex, 0);
  assert.equal(durable.pageLock.tabId, 10);
});
