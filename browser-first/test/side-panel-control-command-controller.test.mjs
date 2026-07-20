import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelControlCommandController } from "../resonantos-side-panel-extension/src/lib/side-panel-control-command-controller.js";

function createHarness({
  activeTab = { id: 42, url: "https://example.com/path" },
  conflict = null,
  consent = null,
  currentControlRun = null,
  currentReadableControlTab = undefined,
  ensureControlTabForUrl = undefined,
  permissionMode = "ask-before-action",
  shouldPreflight = false
} = {}) {
  const events = [];
  let currentRun = currentControlRun;
  let pendingApproval = { id: "approval-existing" };
  let nextDecision = null;
  let schedulerTicks = 0;
  const browserJobStore = {
    async setMonitorCollapsed(collapsed) {
      events.push(["monitor-collapsed", collapsed]);
    },
    conflictingActiveJobForLock(lock, options = {}) {
      events.push(["conflict-check", lock.siteKey, options.excludingJobId ?? ""]);
      return conflict;
    }
  };
  const controller = createSidePanelControlCommandController({
    activeTab: async () => activeTab,
    addMessage: async (role, content) => events.push(["message", role, content]),
    browserJobStore,
    clearControlPreflight: async () => events.push(["clear-preflight"]),
    createBrowserJob: async (request) => {
      const job = { id: request.existingJob?.id ?? "job-created", ...request };
      events.push(["create-job", job]);
      return job;
    },
    currentReadableControlTab: currentReadableControlTab !== undefined
      ? async () => currentReadableControlTab
      : async () => activeTab,
    ensureControlTabForUrl: ensureControlTabForUrl !== undefined
      ? async (url) => ensureControlTabForUrl(url)
      : async (url) => ({ id: 77, url }),
    getBrowserJobScheduler: () => ({
      tick: async () => {
        schedulerTicks += 1;
        events.push(["scheduler-tick"]);
      }
    }),
    getCurrentControlRun: () => currentRun,
    permissionForUrl: async () => permissionMode,
    persistContextDockExpanded: async () => events.push(["persist-dock"]),
    renderControlMonitor: () => events.push(["render-control"]),
    renderJobMonitor: () => events.push(["render-jobs"]),
    requestControlPreflight: async (request) => events.push(["preflight", request]),
    setActivity: (...args) => events.push(["activity", ...args]),
    setContextDockExpanded: (expanded) => events.push(["dock", expanded]),
    setCurrentControlRun: (run) => {
      currentRun = run;
      events.push(["current-run", run]);
    },
    setNextControlPreflightDecision: (decision) => {
      nextDecision = decision;
      events.push(["decision", decision?.mode ?? ""]);
    },
    setPendingApproval: (approval) => {
      pendingApproval = approval;
      events.push(["approval", approval]);
    },
    setStatus: (status) => events.push(["status", status]),
    shouldRequireControlPreflight: () => shouldPreflight,
    siteKeyForUrl: (url) => new URL(url || "https://unknown.invalid").host,
    taskConsentStore: {
      consumeTaskConsent: async (request) => events.push(["consume-consent", request]),
      consentFor: async () => consent
    },
    updateBrowserJob: async (jobId, patch) => events.push(["update-job", jobId, patch])
  });
  return {
    browserJobStore,
    controller,
    events,
    getCurrentRun: () => currentRun,
    getNextDecision: () => nextDecision,
    getPendingApproval: () => pendingApproval,
    getSchedulerTicks: () => schedulerTicks
  };
}

test("control command controller blocks Agent Control on blocked sites before creating jobs", async () => {
  const harness = createHarness({ permissionMode: "blocked" });

  const result = await harness.controller.runControlCommand("click the buy button");

  assert.equal(result, null);
  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Control blocked"));
  assert.equal(harness.events.some((event) => event[0] === "create-job"), false);
  assert.equal(harness.getSchedulerTicks(), 0);
});

test("control command controller requests preflight without queueing autonomous browser work", async () => {
  const harness = createHarness({ shouldPreflight: true });

  const result = await harness.controller.runControlCommand("research current AI browser news");

  assert.equal(result, null);
  assert.ok(harness.events.some((event) => event[0] === "preflight" && event[1].siteKey === "www.bing.com"));
  assert.equal(harness.events.some((event) => event[0] === "create-job"), false);
});

test("control command controller preflights navigation goals against the intended web target, not the active extension page", async () => {
  const harness = createHarness({
    activeTab: { id: 9, url: "chrome-extension://resonantos/src/side-panel.html" },
    currentReadableControlTab: null,
    shouldPreflight: true
  });

  const result = await harness.controller.runControlCommand("go to amazon and find me a mini pc");

  assert.equal(result, null);
  const preflight = harness.events.find((event) => event[0] === "preflight")?.[1];
  assert.equal(preflight.siteKey, "www.amazon.it");
  assert.equal(preflight.tab.url, "https://www.amazon.it/s?k=a%20mini%20pc");
  assert.equal(harness.events.some((event) => event[0] === "create-job"), false);
});

test("control command controller creates a real web tab page lock for navigation goals after approval", async () => {
  const opened = [];
  const harness = createHarness({
    activeTab: { id: 9, url: "chrome-extension://resonantos/src/side-panel.html" },
    currentReadableControlTab: null,
    ensureControlTabForUrl: (url) => {
      opened.push(url);
      return { id: 88, url, title: "Amazon search" };
    }
  });

  const lock = await harness.controller.prepareBrowserJobPageLock({
    goal: "go to amazon and find me a mini pc",
    status: "queued"
  });

  assert.deepEqual(opened, ["https://www.amazon.it/s?k=a%20mini%20pc"]);
  assert.equal(lock.tabId, 88);
  assert.equal(lock.siteKey, "www.amazon.it");
  assert.equal(lock.url, "https://www.amazon.it/s?k=a%20mini%20pc");
});

test("control command controller refuses current-page jobs when only ResonantOS extension pages are active", async () => {
  const harness = createHarness({
    activeTab: { id: 9, url: "chrome-extension://resonantos/src/side-panel.html" },
    currentReadableControlTab: null
  });

  const result = await harness.controller.runControlCommand("click the Add button on this page");

  assert.equal(result, null);
  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Control target unavailable"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /normal web page target/.test(event[2])));
  assert.equal(harness.events.some((event) => event[0] === "create-job"), false);
});

test("control command controller queues browser jobs and ticks the scheduler after approval", async () => {
  const harness = createHarness({
    consent: {
      id: "consent-1",
      mode: "allow-safe",
      siteKey: "example.com",
      taskClass: "research",
      reason: "trusted test"
    }
  });

  const job = await harness.controller.runControlCommand("find current news");

  assert.equal(job.id, "job-created");
  assert.equal(job.status, "queued");
  assert.equal(job.planner, "observe-act-verify-loop");
  assert.equal(harness.getNextDecision().mode, "skipped-by-consent");
  assert.ok(harness.events.some((event) => event[0] === "monitor-collapsed" && event[1] === false));
  assert.equal(harness.getSchedulerTicks(), 1);
});

test("control command controller consumes one-time task consent when it skips preflight", async () => {
  const harness = createHarness({
    consent: {
      id: "consent-once",
      mode: "allow-once",
      siteKey: "example.com",
      taskClass: "research",
      reason: "single run"
    }
  });

  const job = await harness.controller.runControlCommand("find current news");

  assert.equal(job.id, "job-created");
  assert.equal(harness.getNextDecision().mode, "allowed-task-class-once");
  assert.ok(harness.events.some((event) => event[0] === "consume-consent" && event[1].taskClass === "research"));
  assert.equal(harness.getSchedulerTicks(), 1);
});

test("control command controller allows queued jobs to share locked targets without stealing active focus", async () => {
  const harness = createHarness({
    conflict: {
      id: "job-active",
      status: "running"
    }
  });

  const lock = await harness.controller.prepareBrowserJobPageLock({
    goal: "queued task",
    status: "queued"
  });

  assert.equal(lock.siteKey, "example.com");
  assert.equal(lock.tabId, 42);
  assert.equal(harness.events.some((event) => event[0] === "update-job"), false);
});

test("control command controller cancels stale approval conflicts before taking page lock", async () => {
  const harness = createHarness({
    conflict: {
      artifacts: [{ type: "old" }],
      goal: "old approval",
      id: "job-approval",
      planner: "observe-act-verify-loop",
      status: "approval",
      steps: [{ label: "old step" }],
      summary: "old summary"
    },
    currentControlRun: {
      artifacts: [{ type: "current" }],
      id: "job-approval",
      planner: "observe-act-verify-loop",
      status: "approval",
      steps: [{ label: "current step" }],
      summary: "current summary"
    }
  });
  let firstConflict = true;
  harness.browserJobStore.conflictingActiveJobForLock = (lock) => {
    harness.events.push(["conflict-check", lock.siteKey]);
    if (firstConflict) {
      firstConflict = false;
      return {
        artifacts: [{ type: "old" }],
        id: "job-approval",
        planner: "observe-act-verify-loop",
        status: "approval",
        steps: [{ label: "old step" }],
        summary: "old summary"
      };
    }
    return null;
  };

  const lock = await harness.controller.prepareBrowserJobPageLock({
    goal: "new task",
    status: "running"
  });

  assert.equal(lock.siteKey, "example.com");
  assert.equal(harness.getPendingApproval(), null);
  assert.equal(harness.getCurrentRun().status, "cancelled");
  assert.ok(harness.events.some((event) => event[0] === "update-job" && event[1] === "job-approval" && event[2].status === "cancelled"));
});
