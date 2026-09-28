import * as jobStorageModule from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  browserJobSchedulerState,
  createBrowserJobStore,
  hasBlockingBrowserJob,
  isActiveBrowserJobStatus,
  isLockHoldingBrowserJobStatus,
  isTerminalBrowserJobStatus,
  normalizeBrowserJob,
  normalizePageLock,
  normalizePendingApproval,
  normalizePreflightDecision,
  staleBrowserJobEvidence
} from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";

function createHarness(initial = {}) {
  const writes = [];
  const argumentsSeen = [];
  const storage = {
    get: async () => structuredClone(initial),
    set: async (payload) => {
      argumentsSeen.push(payload);
      writes.push(structuredClone(payload));
      Object.assign(initial, structuredClone(payload));
    }
  };
  let idIndex = 0;
  const store = createBrowserJobStore({
    storage,
    storageKeys: {
      activeBrowserJob: "active",
      browserJobs: "jobs",
      jobMonitorCollapsed: "collapsed"
    },
    maxJobs: 3,
    now: () => "2026-05-26T10:00:00.000Z",
    createId: () => `job-${++idIndex}`
  });
  return {
    store,
    argumentsSeen,
    backing: initial,
    writes
  };
}

test("browser job store normalizes job shape and status classes", () => {
  const job = normalizeBrowserJob({
    id: 42,
    goal: "x".repeat(400),
    status: "bad",
    planner: "p".repeat(200),
    summary: "s".repeat(800),
    artifacts: Array.from({ length: 25 }, (_, index) => ({ index })),
    steps: [{
      type: "click",
      text: "Continue",
      state: "completed",
      note: "clicked",
      details: {
        phase: "verified",
        observation: { title: "Example", url: "https://example.com" },
        decision: "Click the visible button.",
        action: "Click Continue",
        approvalDecision: "approved-once",
        result: "clicked Continue",
        safetyClass: "safe",
        strategyPhase: "Retarget visible controls.",
        strategyRationale: "Use page-work runbook.",
        completionCheck: "Visible page proves the outcome.",
        confidence: "high",
        uncertainty: "Repeated label on page.",
        ambiguousTarget: true,
        targetCandidates: [
          { ref: "r1", label: "Add", tagName: "button", approvalRequired: false },
          { ref: "r2", label: "Add", tagName: "button", approvalRequired: true, fieldKind: "search-query" }
        ],
        verificationChanged: true,
        verificationRetry: "settle-reread",
        actionRetry: "precise-ref-retry",
        nextHumanAction: "Review target if the click fails.",
        recoveryOptions: []
      },
      timing: {
        startedAt: "2026-05-26T09:59:59.000Z",
        startedAtMs: 1000,
        completedAt: "2026-05-26T10:00:00.000Z",
        completedAtMs: 1800,
        durationMs: 800
      },
      updatedAt: "2026-05-26T10:00:00.000Z"
    }],
    preflightDecision: {
      id: "control-abc",
      goal: "book a call",
      siteKey: "example.com",
      taskClass: "booking",
      mode: "trusted-safe-actions",
      permissionMode: "ask-before-action",
      decidedAt: "2026-05-26T09:59:00.000Z",
      source: "control-preflight",
      reason: "Human trusted safe actions."
    },
    pageLock: {
      type: "tab",
      tabId: 12,
      url: "https://example.com/booking",
      siteKey: "example.com",
      acquiredAt: "2026-05-26T09:59:30.000Z",
      reason: "Agent Control goal"
    },
    timing: {
      startedAt: "2026-05-26T09:59:00.000Z",
      startedAtMs: 1000,
      completedAt: "2026-05-26T10:00:00.000Z",
      completedAtMs: 3000,
      durationMs: 2000
    },
    lastError: "e"
  }, { now: () => "2026-05-26T10:00:00.000Z" });

  assert.equal(job.id, "42");
  assert.equal(job.goal.length, 300);
  assert.equal(job.status, "queued");
  assert.equal(job.planner.length, 120);
  assert.equal(job.summary.length, 700);
  assert.equal(job.artifacts.length, 20);
  assert.deepEqual(job.steps, [{
    type: "click",
    label: "Continue",
    state: "completed",
    note: "clicked",
    details: {
      phase: "verified",
      observation: { title: "Example", url: "https://example.com" },
      decision: "Click the visible button.",
      action: "Click Continue",
      approvalDecision: "approved-once",
      result: "clicked Continue",
      safetyClass: "safe",
      strategyPhase: "Retarget visible controls.",
      strategyRationale: "Use page-work runbook.",
      completionCheck: "Visible page proves the outcome.",
      scenarioName: null,
      preferredProbes: [],
      successSignals: [],
      stopConditions: [],
      confidence: "high",
      uncertainty: "Repeated label on page.",
      ambiguousTarget: true,
      targetCandidates: [
        { approvalRequired: false, context: "", fieldKind: "", form: null, label: "Add", ref: "r1", tagName: "button", visibleIndex: null },
        { approvalRequired: true, context: "", fieldKind: "search-query", form: null, label: "Add", ref: "r2", tagName: "button", visibleIndex: null }
      ],
      humanInterventionState: null,
      verificationChanged: true,
      verificationRetry: "settle-reread",
      actionRetry: "precise-ref-retry",
      nextHumanAction: "Review target if the click fails.",
      recoveryOptions: []
    },
    timing: {
      startedAt: "2026-05-26T09:59:59.000Z",
      startedAtMs: 1000,
      completedAt: "2026-05-26T10:00:00.000Z",
      completedAtMs: 1800,
      durationMs: 800
    },
    updatedAt: "2026-05-26T10:00:00.000Z"
  }]);
  assert.deepEqual(job.timing, {
    startedAt: "2026-05-26T09:59:00.000Z",
    startedAtMs: 1000,
    completedAt: "2026-05-26T10:00:00.000Z",
    completedAtMs: 3000,
    durationMs: 2000
  });
  assert.deepEqual(job.preflightDecision, {
    id: "control-abc",
    goal: "book a call",
    siteKey: "example.com",
    taskClass: "booking",
    mode: "trusted-safe-actions",
    permissionMode: "ask-before-action",
    decidedAt: "2026-05-26T09:59:00.000Z",
    source: "control-preflight",
    reason: "Human trusted safe actions."
  });
  assert.deepEqual(job.pageLock, {
    type: "tab",
    tabId: 12,
    url: "https://example.com/booking",
    siteKey: "example.com",
    acquiredAt: "2026-05-26T09:59:30.000Z",
    reason: "Agent Control goal"
  });
  assert.equal(isActiveBrowserJobStatus("running"), true);
  assert.equal(isLockHoldingBrowserJobStatus("running"), true);
  assert.equal(isLockHoldingBrowserJobStatus("paused"), false);
  assert.equal(isTerminalBrowserJobStatus("cancelled"), true);
  assert.equal(isTerminalBrowserJobStatus("paused"), false);
});

test("hasBlockingBrowserJob flags jobs that need the human", () => {
  assert.equal(hasBlockingBrowserJob([{ status: "running" }, { status: "queued" }]), false);
  assert.equal(hasBlockingBrowserJob([{ status: "approval" }]), true);
  assert.equal(hasBlockingBrowserJob([{ status: "blocked" }]), true);
  assert.equal(hasBlockingBrowserJob([{ status: "failed" }]), true);
  assert.equal(hasBlockingBrowserJob([{ status: "denied" }]), true);
  assert.equal(hasBlockingBrowserJob([{ status: "running", pendingApproval: { step: {} } }]), true);
  assert.equal(hasBlockingBrowserJob([]), false);
  assert.equal(hasBlockingBrowserJob(null), false);
});

test("browser job store persists bounded pending approval only for approval jobs", () => {
  const approval = normalizePendingApproval({
    history: Array.from({ length: 30 }, (_, index) => ({ index })),
    reason: "Submit needs review.",
    results: Array.from({ length: 30 }, (_, index) => ({ index })),
    step: { type: "click", text: "Submit public form" },
    stepIndex: 2
  });

  assert.equal(approval.history.length, 20);
  assert.equal(approval.results.length, 20);
  assert.equal(approval.step.text, "Submit public form");
  assert.equal(approval.stepIndex, 2);

  const waiting = normalizeBrowserJob({
    id: "approval-job",
    goal: "Submit form",
    status: "approval",
    pendingApproval: approval
  });
  const completed = normalizeBrowserJob({
    id: "done-job",
    goal: "Submit form",
    status: "completed",
    pendingApproval: approval
  });

  assert.equal(waiting.pendingApproval.step.text, "Submit public form");
  assert.equal(completed.pendingApproval, null);
});

test("browser job store normalizes page locks conservatively", () => {
  assert.equal(normalizePageLock(null), null);
  assert.equal(normalizePageLock({}), null);
  assert.deepEqual(normalizePageLock({
    type: "page",
    tabId: "42",
    url: "https://example.com/path",
    siteKey: "example.com",
    acquiredAt: "2026-05-26T09:59:30.000Z",
    reason: "r".repeat(240)
  }, { now: () => "2026-05-26T10:00:00.000Z" }), {
    type: "page",
    tabId: 42,
    url: "https://example.com/path",
    siteKey: "example.com",
    acquiredAt: "2026-05-26T09:59:30.000Z",
    reason: "r".repeat(180)
  });
});

test("browser job store normalizes preflight decisions conservatively", () => {
  assert.equal(normalizePreflightDecision(null), null);
  assert.deepEqual(normalizePreflightDecision({
    id: "x".repeat(200),
    goal: "g".repeat(400),
    siteKey: "s".repeat(200),
    taskClass: "t".repeat(120),
    mode: "unsafe",
    permissionMode: "trusted-for-safe-actions",
    decidedAt: "2026-05-26T09:59:00.000Z",
    source: "human",
    reason: "r".repeat(400)
  }), {
    id: "x".repeat(120),
    goal: "g".repeat(300),
    siteKey: "s".repeat(120),
    taskClass: "t".repeat(80),
    mode: "not-required",
    permissionMode: "trusted-for-safe-actions",
    decidedAt: "2026-05-26T09:59:00.000Z",
    source: "human",
    reason: "r".repeat(240)
  });
  assert.equal(normalizePreflightDecision({ goal: "x", mode: "allowed-task-class-once" }).mode, "allowed-task-class-once");
});

test("browser job store hydrates, compacts, and persists browser jobs", async () => {
  const harness = createHarness({
    collapsed: false,
    jobs: [
      { id: "old", goal: "old", status: "completed", updatedAt: "2026-05-25T10:00:00.000Z" },
      { id: "new", goal: "new", status: "running", updatedAt: "2026-05-26T10:00:00.000Z" },
      { id: "bad", goal: "bad", status: "bad", updatedAt: "2026-05-24T10:00:00.000Z" },
      { id: "drop", goal: "drop", updatedAt: "2026-05-23T10:00:00.000Z" }
    ]
  });

  await harness.store.hydrate();

  assert.equal(harness.store.getMonitorCollapsed(), false);
  assert.deepEqual(harness.store.getJobs().map((job) => job.id), ["new", "old", "bad"]);
  assert.equal(harness.store.findJob("new").status, "running");
  assert.equal(harness.store.findJob("bad").status, "queued");

  await harness.store.persist();

  assert.deepEqual(harness.writes.at(-1).jobs.map((job) => job.id), ["new", "old", "bad"]);
  assert.equal(harness.writes.at(-1).collapsed, false);
  assert.equal(harness.writes.at(-1).active, "new");
});

test("browser job store creates active jobs and finds by active, id, or goal", async () => {
  const harness = createHarness();

  const job = await harness.store.createJob({
    goal: "Find a booking slot",
    planner: "loop",
    summary: "summary",
    pageLock: {
      tabId: 7,
      url: "https://example.com/booking",
      siteKey: "example.com",
      reason: "booking task"
    },
    preflightDecision: {
      id: "control-1",
      goal: "Find a booking slot",
      siteKey: "example.com",
      taskClass: "booking",
      mode: "approved-once",
      permissionMode: "ask-before-action",
      decidedAt: "2026-05-26T09:59:00.000Z",
      source: "control-preflight",
      reason: "Approved once."
    }
  });

  assert.equal(job.id, "job-1");
  assert.equal(harness.store.getActiveJobId(), "job-1");
  assert.equal(harness.store.currentJob().id, "job-1");
  assert.equal(harness.store.findJob().id, "job-1");
  assert.equal(harness.store.findJob("booking").id, "job-1");
  assert.equal(harness.writes.at(-1).jobs[0].status, "running");
  assert.equal(harness.writes.at(-1).jobs[0].pageLock.tabId, 7);
  assert.equal(harness.writes.at(-1).jobs[0].pageLock.siteKey, "example.com");
  assert.equal(harness.writes.at(-1).jobs[0].preflightDecision.mode, "approved-once");
  assert.equal(harness.writes.at(-1).jobs[0].preflightDecision.taskClass, "booking");
  assert.equal(harness.writes.at(-1).active, "job-1");
});

test("browser job store hydrates to live work instead of a stale terminal active id", async () => {
  const harness = createHarness({
    active: "job-done",
    jobs: [
      {
        id: "job-done",
        goal: "Done task",
        status: "completed",
        updatedAt: "2026-05-26T09:59:00.000Z"
      },
      {
        id: "job-live",
        goal: "Live task",
        status: "running",
        updatedAt: "2026-05-26T09:58:00.000Z"
      }
    ]
  });

  await harness.store.hydrate();

  assert.equal(harness.store.getActiveJobId(), "job-live");
  assert.equal(harness.store.currentJob().id, "job-live");
});

test("browser job store moves active focus when active runner job becomes terminal and live work remains", async () => {
  const harness = createHarness({
    active: "job-a",
    jobs: [
      {
        id: "job-a",
        goal: "Finish me",
        status: "running",
        updatedAt: "2026-05-26T09:59:00.000Z"
      },
      {
        id: "job-b",
        goal: "Keep watching me",
        status: "running",
        updatedAt: "2026-05-26T09:58:00.000Z"
      }
    ]
  });
  await harness.store.hydrate();

  const completed = await harness.store.updateJob("job-a", { status: "completed" });

  assert.equal(completed.status, "completed");
  assert.equal(harness.store.getActiveJobId(), "job-b");
  assert.equal(harness.writes.at(-1).active, "job-b");
});

test("browser job store can create queued jobs for scheduler-owned execution", async () => {
  const harness = createHarness();

  const job = await harness.store.createJob({
    goal: "Read an unrelated page",
    pageLock: {
      tabId: 9,
      url: "https://docs.example/",
      siteKey: "docs.example",
      reason: "queued scheduler task"
    },
    status: "queued"
  });

  assert.equal(job.status, "queued");
  assert.equal(job.pageLock.siteKey, "docs.example");
  assert.equal(harness.store.getActiveJobId(), job.id);
  assert.deepEqual(harness.store.getSchedulerState({ maxConcurrent: 2 }).runnableQueued.map((item) => item.id), [job.id]);
});

test("browser job store accepts queued page-lock conflicts without stealing active focus", async () => {
  const harness = createHarness();

  const running = await harness.store.createJob({
    goal: "Use site",
    pageLock: {
      tabId: 7,
      url: "https://same.example/",
      siteKey: "same.example",
      reason: "active task"
    },
    status: "running"
  });
  const queued = await harness.store.createJob({
    activate: false,
    goal: "Wait for site",
    pageLock: {
      tabId: 7,
      url: "https://same.example/next",
      siteKey: "same.example",
      reason: "queued task"
    },
    status: "queued"
  });

  assert.equal(harness.store.getActiveJobId(), running.id);
  assert.equal(queued.status, "queued");
  assert.deepEqual(harness.store.getSchedulerState({ maxConcurrent: 2 }).lockBlockedQueued.map((item) => item.id), [queued.id]);
});

test("browser job store blocks conflicting active page locks and releases them when paused or terminal", async () => {
  const harness = createHarness();

  const first = await harness.store.createJob({
    goal: "Book a call",
    pageLock: {
      tabId: 7,
      url: "https://example.com/booking",
      siteKey: "example.com",
      reason: "first task"
    }
  });

  assert.equal(harness.store.conflictingActiveJobForLock({
    tabId: 7,
    url: "https://example.com/other",
    siteKey: "other.example"
  })?.id, first.id);
  assert.equal(harness.store.conflictingActiveJobForLock({
    tabId: 8,
    url: "https://example.com/booking",
    siteKey: "example.com"
  })?.id, first.id);

  await assert.rejects(
    () => harness.store.createJob({
      goal: "Second same tab",
      pageLock: {
        tabId: 7,
        url: "https://example.com/booking",
        siteKey: "example.com"
      }
    }),
    /already controlled by job-1/
  );

  await harness.store.updateJob(first.id, { status: "paused" });
  assert.equal(harness.store.findJob(first.id).pageLock, null);

  const second = await harness.store.createJob({
    goal: "Second after pause",
    pageLock: {
      tabId: 7,
      url: "https://example.com/booking",
      siteKey: "example.com"
    }
  });
  assert.equal(second.id, "job-2");

  await harness.store.updateJob(second.id, { status: "completed" });
  assert.equal(harness.store.findJob(second.id).pageLock, null);
});

test("browser job scheduler identifies runnable, locked, and capacity-waiting queued jobs", () => {
  const state = browserJobSchedulerState([
    {
      id: "running-a",
      goal: "Use DAO page",
      status: "running",
      pageLock: { tabId: 1, siteKey: "dao.example", url: "https://dao.example/" }
    },
    {
      id: "approval-a",
      goal: "Review shop page",
      status: "approval",
      pageLock: { tabId: 2, siteKey: "shop.example", url: "https://shop.example/cart" }
    },
    {
      id: "queued-open",
      goal: "Read docs",
      status: "queued",
      pageLock: { tabId: 3, siteKey: "docs.example", url: "https://docs.example/" }
    },
    {
      id: "queued-locked",
      goal: "Click DAO vote",
      status: "queued",
      pageLock: { tabId: 4, siteKey: "dao.example", url: "https://dao.example/vote" }
    },
    {
      id: "queued-capacity",
      goal: "Research unrelated page",
      status: "queued",
      pageLock: { tabId: 5, siteKey: "research.example", url: "https://research.example/" }
    },
    { id: "paused-a", goal: "Paused", status: "paused" },
    { id: "done-a", goal: "Done", status: "completed" }
  ], { maxConcurrent: 3 });

  assert.equal(state.maxConcurrent, 3);
  assert.equal(state.activeSlots, 2);
  assert.equal(state.availableSlots, 1);
  assert.deepEqual(state.runnableQueued.map((job) => job.id), ["queued-open"]);
  assert.deepEqual(state.lockBlockedQueued.map((job) => [job.id, job.blockerId]), [["queued-locked", "running-a"]]);
  assert.deepEqual(state.capacityBlockedQueued.map((job) => job.id), ["queued-capacity"]);
  assert.equal(state.paused, 1);
  assert.equal(state.terminal, 1);
});

test("browser job store exposes scheduler state for monitor and command surfaces", async () => {
  const harness = createHarness({
    jobs: [
      { id: "running", goal: "Running", status: "running", pageLock: { tabId: 1, siteKey: "a.example" } },
      { id: "queued", goal: "Queued", status: "queued", pageLock: { tabId: 2, siteKey: "b.example" } }
    ]
  });

  await harness.store.hydrate();

  const state = harness.store.getSchedulerState({ maxConcurrent: 2 });
  assert.equal(state.running, 1);
  assert.deepEqual(state.runnableQueued.map((job) => job.id), ["queued"]);
});

test("browser job store detects stale running and approval jobs without mutating status", async () => {
  const stale = staleBrowserJobEvidence({
    id: "job-stale",
    goal: "Find a product",
    status: "running",
    updatedAt: "2026-05-26T09:40:00.000Z",
    steps: [{ type: "read", label: "Read page", state: "completed", updatedAt: "2026-05-26T09:41:00.000Z" }]
  }, {
    now: "2026-05-26T10:00:00.000Z",
    thresholdMs: 10 * 60 * 1000
  });

  assert.equal(stale.reason, "Running job has no recent recorded progress.");
  assert.equal(stale.lastActivityAt, "2026-05-26T09:41:00.000Z");
  assert.equal(stale.ageMs, 19 * 60 * 1000);
  assert.match(stale.nextHumanAction, /continue the job/);

  assert.equal(staleBrowserJobEvidence({
    id: "job-recent",
    goal: "Recent",
    status: "running",
    updatedAt: "2026-05-26T09:55:00.000Z"
  }, {
    now: "2026-05-26T10:00:00.000Z",
    thresholdMs: 10 * 60 * 1000
  }), null);

  assert.equal(staleBrowserJobEvidence({
    id: "job-completed",
    goal: "Completed",
    status: "completed",
    updatedAt: "2026-05-26T09:00:00.000Z"
  }, {
    now: "2026-05-26T10:00:00.000Z",
    thresholdMs: 10 * 60 * 1000
  }), null);

  const approval = staleBrowserJobEvidence({
    id: "job-approval",
    goal: "Approve click",
    status: "approval",
    updatedAt: "2026-05-26T09:00:00.000Z"
  }, {
    now: "2026-05-26T10:00:00.000Z",
    thresholdMs: 10 * 60 * 1000
  });
  assert.equal(approval.reason, "Approval has been waiting without recorded progress.");
  assert.match(approval.nextHumanAction, /approval card/);

  const harness = createHarness({
    jobs: [
      { id: "job-stale", goal: "stale", status: "running", updatedAt: "2026-05-26T09:40:00.000Z" },
      { id: "job-done", goal: "done", status: "completed", updatedAt: "2026-05-26T09:00:00.000Z" }
    ]
  });
  await harness.store.hydrate();

  const staleJobs = harness.store.getStaleJobs({ thresholdMs: 10 * 60 * 1000 });
  assert.equal(staleJobs.length, 1);
  assert.equal(staleJobs[0].job.id, "job-stale");
  assert.equal(harness.store.findJob("job-stale").status, "running");
});

test("browser job store updates terminal completion and monitor collapsed state", async () => {
  const harness = createHarness();
  const job = await harness.store.createJob({ goal: "Task" });

  const updated = await harness.store.updateJob(job.id, { status: "completed", artifacts: [{ type: "report", path: "/tmp/report.md" }] });

  assert.equal(updated.status, "completed");
  assert.equal(updated.completedAt, "2026-05-26T10:00:00.000Z");
  assert.deepEqual(updated.artifacts, [{ type: "report", path: "/tmp/report.md" }]);

  const withSteps = await harness.store.updateJob(job.id, {
    steps: [{ type: "read", label: "Read page", state: "completed", note: "saw result" }]
  });
  assert.deepEqual(withSteps.steps, [{ type: "read", label: "Read page", state: "completed", note: "saw result", details: {}, timing: {}, updatedAt: null }]);

  await harness.store.toggleMonitorCollapsed();
  assert.equal(harness.store.getMonitorCollapsed(), false);
  assert.equal(harness.writes.at(-1).collapsed, false);
});

test("browser job store clears settled jobs but keeps live and focused work", async () => {
  const harness = createHarness();
  const done = await harness.store.createJob({ goal: "done task", activate: false });
  const cancelledJob = await harness.store.createJob({ goal: "cancel task", activate: false });
  const live = await harness.store.createJob({ goal: "live task" });
  await harness.store.updateJob(done.id, { status: "completed" });
  await harness.store.updateJob(cancelledJob.id, { status: "cancelled" });

  const removed = await harness.store.clearCompletedJobs();

  assert.equal(removed, 2);
  assert.deepEqual(harness.store.getJobs().map((job) => job.id), [live.id]);
  assert.equal(harness.store.getActiveJobId(), live.id);
  // The clear must be persisted, not just in-memory.
  assert.deepEqual(harness.writes.at(-1).jobs.map((job) => job.id), [live.id]);
});

test("browser job store leaves blocked and failed jobs when clearing done work", async () => {
  const harness = createHarness();
  const blocked = await harness.store.createJob({ goal: "blocked task", activate: false });
  const failed = await harness.store.createJob({ goal: "failed task", activate: false });
  const done = await harness.store.createJob({ goal: "done task", activate: false });
  await harness.store.updateJob(blocked.id, { status: "blocked" });
  await harness.store.updateJob(failed.id, { status: "failed" });
  await harness.store.updateJob(done.id, { status: "completed" });

  const removed = await harness.store.clearCompletedJobs();

  assert.equal(removed, 1);
  assert.deepEqual(
    harness.store.getJobs().map((job) => job.status).sort(),
    ["blocked", "failed"]
  );
});

test("browser job store preserves human stop state from stale runner updates unless explicitly resumed", async () => {
  const harness = createHarness({
    active: "job-a",
    jobs: [
      {
        id: "job-a",
        goal: "Cancel me",
        status: "cancelled",
        updatedAt: "2026-05-26T09:59:00.000Z",
        pageLock: null,
        steps: [{ type: "read", label: "Read page", state: "completed" }]
      }
    ]
  });
  await harness.store.hydrate();

  const staleCompletion = await harness.store.updateJob("job-a", {
    status: "completed",
    steps: [{ type: "read", label: "Read page", state: "completed" }]
  });

  assert.equal(staleCompletion.status, "cancelled");
  assert.equal(harness.store.findJob("job-a").status, "cancelled");

  const explicitResume = await harness.store.updateJob("job-a", {
    allowHumanStopOverride: true,
    status: "queued",
    pageLock: { tabId: 11, siteKey: "example.test", url: "https://example.test/" }
  });

  assert.equal(explicitResume.status, "queued");
  assert.equal(explicitResume.pageLock.siteKey, "example.test");
});

test("browser job store persists active job and recovers interrupted jobs after reload", async () => {
  const harness = createHarness({
    active: "running-job",
    jobs: [
      { id: "running-job", goal: "recover me", status: "running", updatedAt: "2026-05-26T09:00:00.000Z" },
      { id: "done-job", goal: "done", status: "completed", updatedAt: "2026-05-26T08:00:00.000Z" }
    ]
  });

  await harness.store.hydrate();

  assert.equal(harness.store.getActiveJobId(), "running-job");

  const recovered = await harness.store.recoverInterruptedJobs();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "paused");
  assert.equal(recovered[0].lastError, "Recovered after browser host reload");
  assert.equal(harness.store.findJob("running-job").status, "paused");
  assert.equal(harness.writes.at(-1).active, "running-job");

  await harness.store.activateJob("done-job");
  assert.equal(harness.store.getActiveJobId(), "done-job");
  assert.equal(harness.writes.at(-1).active, "done-job");
});

const traceSecret = 'client_secret="synthetic: private value"';
const traceClean = 'client_secret="REDACTED"';
const latestJob = (harness, id) => harness.writes.at(-1).jobs.find((job) => job.id === id);

test('every persisted text-bearing branch is sanitized while live text remains usable', async () => {
  const h = createHarness();
  const job = await h.store.createJob({ goal: traceSecret, planner: traceSecret, summary: traceSecret,
    pageLock: { tabId: 7, url: 'https://example.test/?view=wide', siteKey: 'example.test', reason: traceSecret },
    preflightDecision: { id: 'control-safe', siteKey: 'example.test', taskClass: 'read', goal: traceSecret, reason: traceSecret, source: traceSecret, permissionMode: traceSecret } });
  const fields = ['phase', 'decision', 'action', 'approvalDecision', 'result', 'safetyClass', 'strategyPhase', 'strategyRationale', 'completionCheck', 'scenarioName', 'humanInterventionState', 'uncertainty', 'verificationRetry', 'actionRetry', 'nextHumanAction'];
  const details = Object.fromEntries(fields.map((field) => [field, traceSecret]));
  Object.assign(details, { observation: { title: traceSecret, url: traceSecret }, preferredProbes: [traceSecret], successSignals: [traceSecret], stopConditions: [traceSecret], recoveryOptions: [traceSecret], targetCandidates: [{ ref: traceSecret, label: traceSecret, context: traceSecret, fieldKind: traceSecret, tagName: traceSecret, form: { id: traceSecret, label: traceSecret, name: traceSecret } }] });
  const live = await h.store.updateJob(job.id, { status: 'approval', lastError: traceSecret,
    artifacts: [{ title: traceSecret, nested: [{ password: 'x', pin: 1234, note: traceSecret }] }],
    steps: [{ type: traceSecret, label: traceSecret, state: traceSecret, note: traceSecret, details, updatedAt: 'token=x', timing: { startedAt: 'token=x' } }],
    pendingApproval: { step: { type: 'type', text: traceSecret }, reason: traceSecret, history: [{ note: traceSecret }], results: [{ password: 'x' }] } });
  assert.equal(live.goal, traceSecret); assert.equal(live.pendingApproval.step.text, traceSecret);
  const saved = latestJob(h, job.id);
  for (const field of ['goal', 'planner', 'summary', 'lastError']) assert.equal(saved[field], traceClean, field);
  for (const field of ['goal', 'reason', 'source', 'permissionMode']) assert.equal(saved.preflightDecision[field], traceClean, `preflight.${field}`);
  assert.equal(saved.pageLock.reason, traceClean); assert.equal(saved.pageLock.tabId, 7);
  assert.equal(saved.preflightDecision.id, 'control-safe'); assert.equal(saved.pageLock.url, 'https://example.test/?view=wide');
  for (const field of ['type', 'label', 'state', 'note']) assert.equal(saved.steps[0][field], traceClean, `step.${field}`);
  for (const field of fields) assert.equal(saved.steps[0].details[field], traceClean, `details.${field}`);
  for (const field of ['preferredProbes', 'successSignals', 'stopConditions', 'recoveryOptions']) assert.deepEqual(saved.steps[0].details[field], [traceClean], field);
  assert.deepEqual(saved.steps[0].details.observation, { title: traceClean, url: traceClean });
  for (const field of ['ref', 'label', 'context', 'fieldKind', 'tagName']) assert.equal(saved.steps[0].details.targetCandidates[0][field], traceClean, field);
  for (const field of ['id', 'label', 'name']) assert.equal(saved.steps[0].details.targetCandidates[0].form[field], traceClean, field);
  assert.equal(saved.steps[0].updatedAt, 'token=REDACTED'); assert.equal(saved.steps[0].timing.startedAt, 'token=REDACTED');
  assert.deepEqual(saved.artifacts, [{ title: traceClean, nested: [{ password: 'REDACTED', pin: 'REDACTED', note: traceClean }] }]);
  assert.deepEqual(saved.pendingApproval, { step: { type: 'type', text: traceClean }, reason: traceClean, history: [{ note: traceClean }], results: [{ password: 'REDACTED' }], stepIndex: 0 });
  for (const argument of h.argumentsSeen) assert.doesNotMatch(JSON.stringify(argument), /synthetic|private value/);
});

test('redaction precedes truncation on creation updates and migration', async () => {
  const provider = 'ghp_' + 'x'.repeat(24);
  const long = (bound) => 'ordinary '.repeat(Math.ceil(bound / 9)).slice(0, bound - 9) + ' ' + provider;
  const expected = (bound) => 'ordinary '.repeat(Math.ceil(bound / 9)).slice(0, bound - 9) + ' [REDACTE';
  const h = createHarness();
  const job = await h.store.createJob({ goal: long(300), summary: long(700) });
  assert.equal(latestJob(h, job.id).goal, expected(300)); assert.equal(latestJob(h, job.id).summary, expected(700));
  await h.store.updateJob(job.id, { goal: long(300), steps: [{ details: { observation: { url: long(240) } } }] });
  assert.equal(latestJob(h, job.id).steps[0].details.observation.url, expected(240));
  await h.store.setMonitorCollapsed(false);
  assert.equal(latestJob(h, job.id).goal, expected(300), 'later writes retain pre-truncation redaction');
  const migrated = createHarness({ jobs: [{ id: 'old', status: 'completed', goal: long(300), summary: long(700) }] });
  await migrated.store.hydrate();
  assert.equal(migrated.store.getJobs()[0].goal, expected(300));
  const locked = await h.store.createJob({ goal: 'target', pageLock: { tabId: 2, url: long(240) } });
  assert.equal(latestJob(h, locked.id).pageLock, null); assert.equal(latestJob(h, locked.id).status, 'paused');
});

test('all mutation paths write detached sanitized snapshots', async () => {
  const h = createHarness(); const job = await h.store.createJob({ goal: traceSecret });
  const live = await h.store.updateJob(job.id, { artifacts: [{ nested: { note: traceSecret } }] });
  const argument = h.argumentsSeen.at(-1); const before = structuredClone(argument);
  live.artifacts[0].nested.note = 'mutated';
  assert.deepEqual(argument, before, 'storage set argument has no live aliases');
  await h.store.activateJob(job.id); await h.store.persist();
  await h.store.recoverInterruptedJobs({ reason: traceSecret });
  await h.store.setMonitorCollapsed(false); await h.store.toggleMonitorCollapsed(); await h.store.clearCompletedJobs();
  for (const write of h.writes) assert.doesNotMatch(JSON.stringify(write), /synthetic|private value/);
});

test('legacy migration sanitizes approvals and artifacts and is idempotent', async () => {
  const h = createHarness({ active: 'safe', collapsed: false, jobs: [{ id: 'safe', status: 'approval', goal: traceSecret, updatedAt: '2026-05-26T09:00:00.000Z', artifacts: [{ password: 'x' }], pendingApproval: { step: { text: traceSecret }, history: [{ pin: 1 }] } }] });
  await h.store.hydrate();
  assert.equal(h.store.currentJob().goal, traceClean);
  assert.equal(h.store.currentJob().pendingApproval.step.text, traceClean);
  assert.equal(h.writes.length, 1, 'migration is written back');
  assert.equal(h.backing.active, 'safe'); assert.equal(h.backing.collapsed, false);
  const next = createHarness(h.backing); await next.store.hydrate();
  assert.equal(next.writes.length, 0, 'sanitized migration is stable');
  assert.deepEqual(next.store.snapshot(), h.store.snapshot());
});

test('hydration does not write missing keys whose effective values are already defaults', async () => {
  for (const initial of [{}, { jobs: [] }, { active: null, collapsed: false }]) {
    const h = createHarness(initial);
    await h.store.hydrate();
    assert.equal(h.writes.length, 0, 'absent default-valued keys need no migration write');
    assert.deepEqual(h.store.snapshot(), {
      activeJobId: null, jobs: [], monitorCollapsed: initial.collapsed ?? true
    });
  }

  const seed = createHarness();
  await seed.store.createJob({ goal: 'safe job' });
  const { collapsed, ...withoutPreference } = seed.backing;
  const unchanged = createHarness(withoutPreference);
  await unchanged.store.hydrate();
  assert.equal(unchanged.writes.length, 0, 'missing default preference does not rewrite clean jobs');

  const { active, ...withoutFocus } = seed.backing;
  const focused = createHarness(withoutFocus);
  await focused.store.hydrate();
  assert.equal(focused.writes.length, 1, 'a selected job differs from the missing focus default');
  assert.equal(focused.backing.active, active);

  const legacy = createHarness({ jobs: [{ id: 'old', goal: traceSecret, status: 'queued' }] });
  await legacy.store.hydrate();
  assert.equal(legacy.writes.length, 1, 'missing envelope keys never bypass secret migration');
  assert.equal(legacy.backing.jobs[0].goal, traceClean);
});

test('identity migration preserves safe handles and separates unsafe handles', async () => {
  const unsafe = ['token=first', 'token=second'];
  const h = createHarness({ active: unsafe[1], jobs: [...unsafe, 'job-safe'].map((id) => ({ id, status: 'queued', goal: 'safe' })) });
  await h.store.hydrate();
  const ids = h.store.getJobs().map((job) => job.id);
  assert.equal(new Set(ids).size, 3); assert.ok(ids.includes('job-safe'));
  assert.ok(ids.every((id) => !id.includes('token=') && !id.includes('REDACTED')));
  assert.equal(h.store.getActiveJobId(), ids[1]);
  await h.store.updateJob(ids[0], { id: 'rename', summary: 'updated' });
  assert.equal(h.store.findJob(ids[0]).id, ids[0], 'updates cannot rename identities');
  const next = createHarness(h.backing); await next.store.hydrate();
  assert.deepEqual(next.store.getJobs().map((job) => job.id), h.store.getJobs().map((job) => job.id));
});

test('redacted routing metadata cannot become a shared execution key', async () => {
  for (const field of ['url', 'siteKey']) {
    const h = createHarness();
    const job = await h.store.createJob({ goal: 'route', pageLock: { tabId: 4, [field]: 'token=route-private' } });
    assert.equal(job.status, 'running'); assert.equal(job.pageLock[field], 'token=route-private');
    const saved = latestJob(h, job.id);
    assert.equal(saved.status, 'paused'); assert.equal(saved.pageLock, null); assert.equal(saved.pendingApproval, null);
    assert.equal(saved.lastError, 'Saved target details were redacted. Check the page before resuming.');
  }
  for (const field of ['id', 'siteKey', 'taskClass']) {
    const h = createHarness(); const job = await h.store.createJob({ goal: 'route', preflightDecision: { [field]: 'token=route-private' } });
    assert.equal(latestJob(h, job.id).preflightDecision, null); assert.equal(latestJob(h, job.id).status, 'paused');
  }
});

test('live and durable lifecycle decisions stay aligned', async () => {
  let tick = 0; const writes = [];
  const store = createBrowserJobStore({ storage: { set: async (value) => writes.push(structuredClone(value)) }, storageKeys: { browserJobs: 'jobs' }, now: () => new Date(1_800_000_000_000 + tick++).toISOString(), createId: () => 'safe' });
  const job = await store.createJob({ goal: traceSecret, pageLock: { tabId: 7 } });
  for (const patch of [{ status: 'approval', pendingApproval: { step: { text: traceSecret } } }, { status: 'paused' }, { status: 'completed' }, { status: 'running', allowHumanStopOverride: true }, { status: 'cancelled' }, { status: 'completed', summary: traceSecret }]) {
    const live = await store.updateJob(job.id, patch); const saved = writes.at(-1).jobs[0];
    for (const field of ['id', 'status', 'createdAt', 'updatedAt', 'completedAt', 'pageLock']) assert.deepEqual(saved[field], live[field], field);
    assert.equal(saved.goal, traceClean);
  }
});

test('approval admission cannot be resurrected by shrinking or invalidate live approval by expansion', async () => {
  const h = createHarness(); const job = await h.store.createJob({ goal: 'approval' });
  await h.store.updateJob(job.id, { status: 'approval', pendingApproval: { step: { password: 'x'.repeat(4100) } } });
  assert.equal(h.store.currentJob().pendingApproval, null); assert.equal(latestJob(h, job.id).pendingApproval, null);
  const expanded = { values: Array.from({ length: 230 }, () => ({ pin: 1 })) };
  const live = await h.store.updateJob(job.id, { pendingApproval: { step: expanded } });
  assert.ok(live.pendingApproval); assert.equal(latestJob(h, job.id).pendingApproval, null, 'durable expansion exceeds 4000');
  const history = [{ values: Array.from({ length: 700 }, () => ({ pin: 1 })) }];
  await h.store.updateJob(job.id, { pendingApproval: { step: { text: traceSecret }, history, results: history } });
  assert.equal(h.store.currentJob().pendingApproval.history.length, 1);
  assert.deepEqual(latestJob(h, job.id).pendingApproval.history, []); assert.deepEqual(latestJob(h, job.id).pendingApproval.results, []);
  await h.store.updateJob(job.id, { pendingApproval: { step: { text: traceSecret }, history: [{ password: 'x'.repeat(12000) }], results: [{ password: 'x'.repeat(12000) }] } });
  assert.deepEqual(latestJob(h, job.id).pendingApproval.history, []); assert.deepEqual(latestJob(h, job.id).pendingApproval.results, []);
  await h.store.updateJob(job.id, { status: 'completed' }); assert.equal(latestJob(h, job.id).pendingApproval, null);
});

test('migration and later mutations preserve storage order', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let started; const migrationStarted = new Promise((resolve) => { started = resolve; });
  const writes = [];
  const store = createBrowserJobStore({ storageKeys: { browserJobs: 'jobs', activeBrowserJob: 'active', jobMonitorCollapsed: 'collapsed' }, storage: {
    get: async () => ({ jobs: [{ id: 'old', goal: traceSecret, status: 'queued' }] }),
    set: async (value) => { started(); if (!writes.length) await gate; writes.push(structuredClone(value)); }
  } });
  const hydration = store.hydrate();
  // Baseline has no migration write; avoid a hanging red test.
  await Promise.race([migrationStarted, hydration]);
  assert.equal(store.getJobs().length, 0, 'do not install legacy records before migration write finishes');
  const update = store.updateJob('old', { summary: traceSecret });
  release(); await Promise.all([hydration, update]);
  assert.equal(writes.length, 2); assert.equal(writes.at(-1).jobs[0].summary, traceClean);
  assert.doesNotMatch(JSON.stringify(writes), /synthetic|private value/);
});

test('duplicate legacy and generated identities never collapse retained jobs', async () => {
  const h = createHarness({ active: 'job-redacted-1', jobs: [
    { id: 'token=first', status: 'queued', goal: 'unsafe' },
    { id: 'job-redacted-1', status: 'queued', goal: 'first safe' },
    { id: 'job-redacted-1', status: 'queued', goal: 'duplicate' }
  ] });
  await h.store.hydrate();
  assert.equal(new Set(h.store.getJobs().map((job) => job.id)).size, 3);
  assert.equal(h.store.currentJob().goal, 'first safe');
  const store = createBrowserJobStore({ storageKeys: { browserJobs: 'jobs' }, createId: () => 'token=generated' });
  const first = await store.createJob({ goal: 'first' }); const second = await store.createJob({ goal: 'second' });
  assert.notEqual(first.id, second.id); assert.equal(store.getJobs().length, 2);
  assert.match(first.id, /^job-/); assert.doesNotMatch(first.id, /token|REDACTED/);
});

test('approval step history and result admission honor exact JSON boundaries', async () => {
  const padded = (chars, wrap = false) => {
    const value = { pin: 1, padding: '' };
    const base = wrap ? [value] : value;
    value.padding = '.'.repeat(chars - JSON.stringify(base).length);
    assert.equal(JSON.stringify(base).length, chars);
    return base;
  };
  const h = createHarness(); const job = await h.store.createJob({ goal: 'bounds' });
  // Replacing numeric 1 with the JSON string "REDACTED" expands by 9.
  for (const size of [3991, 3992, 4000, 4001]) {
    const live = await h.store.updateJob(job.id, { status: 'approval', pendingApproval: { step: padded(size) } });
    assert.equal(Boolean(live.pendingApproval), size <= 4000, `raw step size ${size}`);
    const saved = latestJob(h, job.id).pendingApproval;
    assert.equal(Boolean(saved), size <= 3991, `durable step size ${size + 9}`);
    if (saved) assert.equal(JSON.stringify(saved.step).length, 4000);
  }
  for (const size of [11991, 11992, 12000, 12001]) {
    const live = await h.store.updateJob(job.id, { pendingApproval: { step: { type: 'click' }, history: padded(size, true), results: padded(size, true) } });
    for (const field of ['history', 'results']) {
      assert.equal(live.pendingApproval[field].length, size <= 12000 ? 1 : 0, `raw ${field} size ${size}`);
      const saved = latestJob(h, job.id).pendingApproval[field];
      assert.equal(saved.length, size <= 11991 ? 1 : 0, `durable ${field} size ${size + 9}`);
      if (saved.length) assert.equal(JSON.stringify(saved).length, 12000);
    }
  }
});

test('overlapping ordinary writes retain order and detached call-time snapshots', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const writes = []; let calls = 0;
  const store = createBrowserJobStore({ storageKeys: { browserJobs: 'jobs' }, createId: () => 'safe', storage: {
    set: async (value) => { const call = ++calls; if (call === 1) await gate; writes.push(structuredClone(value)); }
  } });
  const creation = store.createJob({ goal: traceSecret });
  const update = store.updateJob('safe', { summary: traceSecret });
  const persistence = store.persist();
  assert.equal(store.findJob('safe').summary, traceSecret, 'live mutations remain immediate');
  assert.equal(calls, 1, 'only the oldest write starts before it settles');
  release(); await Promise.all([creation, update, persistence]);
  assert.equal(writes.length, 3); assert.equal(writes[0].jobs[0].summary, '');
  assert.equal(writes[1].jobs[0].summary, traceClean); assert.equal(writes[2].jobs[0].summary, traceClean);
  assert.doesNotMatch(JSON.stringify(writes), /synthetic|private value/);
});

test('a queued second hydration waits for mutations admitted after the first hydration', async () => {
  let releaseMigration; const migrationGate = new Promise((resolve) => { releaseMigration = resolve; });
  let releaseUpdate; const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  let reads = 0; let writes = 0; let backing = { jobs: [{ id: 'safe', goal: traceSecret, status: 'queued' }] };
  const store = createBrowserJobStore({ storageKeys: { browserJobs: 'jobs', activeBrowserJob: 'active', jobMonitorCollapsed: 'collapsed' }, storage: {
    get: async () => { reads++; return structuredClone(backing); },
    set: async (value) => { writes++; await (writes === 1 ? migrationGate : updateGate); backing = structuredClone(value); }
  } });
  const first = store.hydrate();
  const update = store.updateJob('safe', { summary: traceSecret });
  const second = store.hydrate();
  releaseMigration(); await first;
  await new Promise((resolve) => setImmediate(resolve));
  const readsBeforeUpdateSettled = reads;
  releaseUpdate(); await Promise.all([update, second]);
  assert.equal(readsBeforeUpdateSettled, 1, 'do not read stale storage ahead of an earlier mutation');
  assert.equal(store.currentJob().summary, traceClean);
});

const historyKeys = { browserJobs: "jobs", activeBrowserJob: "active", jobMonitorCollapsed: "collapsed" };
const historyNow = () => "2026-05-26T10:00:00.000Z";
function savedHistory() {
  return { jobs: [normalizeBrowserJob({ id: "saved", goal: "Saved work", status: "completed" }, { now: historyNow })], active: "saved", collapsed: false };
}
function historyHarness(backing = savedHistory()) {
  const writes = [];
  let allocated = 0;
  const storage = {
    get: async () => structuredClone(backing),
    set: async (value) => {
      writes.push(structuredClone(value));
      Object.assign(backing, structuredClone(value));
    }
  };
  const store = createBrowserJobStore({ storage, storageKeys: historyKeys, now: historyNow, createId: () => `new-${++allocated}` });
  return { store, storage, backing, writes, allocated: () => allocated };
}

for (const field of ["goal", "pageLock.url", "id"]) {
  for (const rehydrate of [false, true]) {
    test(`resolved hydration errors block writes and recover (${field}, rehydrate=${rehydrate})`, async () => {
      const h = historyHarness();
      if (rehydrate) await h.store.hydrate();
      const before = structuredClone(h.backing);
      const liveBefore = structuredClone(h.store.snapshot());
      const successfulGet = h.storage.get;
      const payload = structuredClone(before);
      const record = payload.jobs[0];
      let idReads = 0;
      const getter = () => {
        // Reach the raw record spread after identity reservation and selection.
        if (field === "id" && ++idReads < 3) return "saved";
        throw new Error(`unreadable ${field}`);
      };
      if (field === "pageLock.url") {
        record.pageLock = {};
        Object.defineProperty(record.pageLock, "url", { enumerable: true, get: getter });
      } else {
        Object.defineProperty(record, field, { enumerable: true, get: getter });
      }
      // Resolve the payload directly: structuredClone would throw inside get().
      h.storage.get = async () => payload;

      await assert.rejects(h.store.hydrate(), { message: `unreadable ${field}` });
      assert.deepEqual(h.store.snapshot(), liveBefore, "failed hydration must not install partial state");
      assert.equal(await h.store.createJob({ goal: "Refused work" }), null,
        "failed normalization must refuse creation");
      await h.store.persist();
      assert.equal(h.store.isHistoryReadBlocked(), true);
      assert.equal(h.allocated(), 0);
      assert.equal(h.writes.length, 0, "failed normalization must suppress every attempted write");
      assert.deepEqual(h.backing, before, "saved history must remain unchanged");

      h.storage.get = successfulGet;
      await h.store.hydrate();
      assert.equal(h.store.isHistoryReadBlocked(), false);
      assert.deepEqual(h.store.getJobs().map((job) => job.id), ["saved"]);
      const created = await h.store.createJob({ goal: "New work" });
      assert.equal(created.id, "new-1");
      assert.deepEqual(h.backing.jobs.map((job) => job.id).sort(), ["new-1", "saved"]);
    });
  }
}

for (const synchronous of [false, true]) {
  test(`failed hydration preserves backing history across every mutation (${synchronous ? "thrown" : "rejected"})`, async () => {
    const h = historyHarness();
    const before = structuredClone(h.backing);
    h.storage.get = synchronous
      ? () => { throw new Error("history read failed"); }
      : async () => { throw new Error("history read failed"); };
    await assert.doesNotReject(h.store.hydrate());
    assert.deepEqual(h.store.getJobs(), []);
    assert.equal(h.writes.length, 0, "failed hydration must not migrate");
    const results = await Promise.all([
      h.store.activateJob("saved"), h.store.clearCompletedJobs(),
      h.store.createJob({ goal: "New work" }), h.store.persist(),
      h.store.recoverInterruptedJobs(), h.store.setMonitorCollapsed(false),
      h.store.toggleMonitorCollapsed(), h.store.updateJob("saved", { summary: "Update" })
    ]);
    assert.equal(h.writes.length, 0, "failed history read must suppress every attempted write");
    assert.deepEqual(h.backing, before);
    assert.equal(results[2], null, "failed history read must refuse creation");
    assert.equal(h.allocated(), 0);
    assert.equal(h.store.isHistoryReadBlocked(), true);
  });
}

test("mutations waiting on rejected hydration cannot write or create jobs", { timeout: 2000 }, async (t) => {
  const h = historyHarness();
  const before = structuredClone(h.backing);
  const read = Promise.withResolvers();
  t.after(() => read.resolve({}));
  h.storage.get = () => read.promise;
  const hydration = h.store.hydrate();
  const pending = Promise.all([hydration, h.store.createJob({ goal: "New work" }),
    h.store.updateJob("saved", { summary: "Update" }), h.store.setMonitorCollapsed(false), h.store.persist()]);
  assert.equal(h.allocated(), 0);
  assert.equal(h.writes.length, 0);
  read.reject(new Error("history read failed"));
  const results = await pending;
  assert.equal(results[1], null, "waiting creation must resolve null after rejected hydration");
  assert.equal(h.allocated(), 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.backing, before);
});

for (const kind of ["canonical", "empty", "legacy"]) {
  test(`only a successful read reopens persistence and admission (${kind})`, async () => {
    const initial = kind === "empty" ? {} : kind === "legacy"
      ? { jobs: [{ id: "saved", goal: "Saved work", status: "completed" }], active: "saved" } : savedHistory();
    const h = historyHarness(initial);
    const before = structuredClone(initial);
    const successfulGet = h.storage.get;
    h.storage.get = async () => { throw new Error("history read failed"); };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 2) delete h.storage.get;
      await h.store.hydrate();
      assert.equal(await h.store.createJob({ goal: "Refused work" }), null, "failed or absent retry cannot reopen admission");
      await h.store.persist();
      assert.equal(h.writes.length, 0);
      assert.equal(h.allocated(), 0);
      assert.deepEqual(h.backing, before);
      assert.equal(h.store.isHistoryReadBlocked(), true);
    }
    h.storage.get = successfulGet;
    await h.store.hydrate();
    assert.equal(h.store.isHistoryReadBlocked(), false);
    assert.deepEqual(h.store.getJobs().map((job) => job.id), kind === "empty" ? [] : ["saved"]);
    assert.equal(h.writes.length, kind === "legacy" ? 1 : 0, "recovery must enable required migration writes");
    const created = await h.store.createJob({ goal: "New work" });
    assert.equal(created.id, "new-1");
    assert.deepEqual(h.backing.jobs.map((job) => job.id).sort(), kind === "empty" ? ["new-1"] : ["new-1", "saved"]);
  });
}

test("failed rehydration blocks writes after an earlier write settles", { timeout: 2000 }, async (t) => {
  const h = historyHarness();
  await h.store.hydrate();
  const write = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const read = Promise.withResolvers();
  t.after(() => { write.resolve(); read.resolve({}); readStarted.resolve(); });
  let reads = 0;
  h.storage.set = async (value) => {
    h.writes.push(structuredClone(value));
    await write.promise;
    Object.assign(h.backing, structuredClone(value));
  };
  h.storage.get = () => { reads++; readStarted.resolve(); return read.promise; };
  const earlier = h.store.updateJob("saved", { summary: "Committed update" });
  const hydration = h.store.hydrate();
  const pending = Promise.all([earlier, hydration, h.store.updateJob("saved", { summary: "Unsafe later update" }), h.store.persist()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0, "rehydration must wait for the earlier write");
  assert.equal(h.writes.length, 1);
  write.resolve();
  await readStarted.promise;
  const committed = structuredClone(h.backing);
  assert.equal(committed.jobs[0].summary, "Committed update");
  read.reject(new Error("history read failed"));
  await pending;
  assert.equal(h.writes.length, 1, "post-failure mutations must not attempt another write");
  assert.deepEqual(h.backing, committed);
});

for (const kind of ["absent", "empty", "set-only"]) {
  test(`hydration without a readable adapter preserves creation and persistence contracts (${kind})`, async () => {
    const writes = [];
    const storage = kind === "absent" ? undefined : kind === "empty" ? {} : { set: async (value) => writes.push(structuredClone(value)) };
    const store = createBrowserJobStore({ storage, storageKeys: historyKeys, createId: () => "new", now: historyNow });
    await store.hydrate();
    const job = await store.createJob({ goal: "Local work" });
    assert.equal(job.id, "new");
    const updated = await store.updateJob(job.id, { summary: "Updated locally" });
    assert.equal(updated.summary, "Updated locally");
    await store.persist();
    assert.equal(store.currentJob().summary, "Updated locally");
    assert.equal(writes.length, kind === "set-only" ? 3 : 0);
    assert.equal(store.isHistoryReadBlocked(), false);
  });
}

test("write rejection after a successful read remains resolved", async () => {
  let writes = 0;
  const store = createBrowserJobStore({ storageKeys: historyKeys, storage: {
    get: async () => ({}),
    set: async () => { writes++; throw new Error("synthetic write failure"); }
  } });
  await store.hydrate();
  const job = await store.createJob({ goal: traceSecret });
  assert.equal(job.goal, traceSecret);
  await assert.doesNotReject(store.updateJob(job.id, { summary: traceSecret }));
  assert.equal(writes, 2);
});

// External writers share only this adapter/key queue, never the live store queue.
const externalKeys = { browserJobs: "jobs", activeBrowserJob: "active", pendingSidebarPrompt: "prompt" };
function externalHarness(jobs = [], active = null) {
  const data = { jobs, active }; const writes = []; let reads = 0;
  const storage = {
    async get() { reads++; return structuredClone(data); },
    async set(value) { writes.push(value); Object.assign(data, structuredClone(value)); }
  };
  const mutate = (mutation, options = {}) => {
    assert.equal(typeof jobStorageModule.mutateBrowserJobStorage, "function", "shared storage mutation helper must exist");
    return jobStorageModule.mutateBrowserJobStorage({ storage, storageKeys: externalKeys,
      now: () => "2026-05-26T10:00:00.000Z", mutation, ...options });
  };
  return { data, writes, storage, mutate, reads: () => reads };
}

for (const removesFocus of [true, false]) {
  test(`external Settings clear with single-key reads ${removesFocus ? "repairs removed" : "preserves surviving"} focus`, async () => {
    const running = normalizeBrowserJob({ id: "running", status: "running" }, {
      now: () => "2026-05-26T10:00:00.000Z"
    });
    const h = externalHarness([
      { id: "completed", status: "completed" }, structuredClone(running)
    ], removesFocus ? "completed" : "running");
    h.storage.get = async (key) => {
      assert.equal(typeof key, "string", "adapter only accepts single-key reads");
      return { [key]: structuredClone(h.data[key]) };
    };

    const result = await h.mutate({ type: "clear-settings-terminal" });

    assert.deepEqual(h.writes, [removesFocus
      ? { jobs: [running], active: null }
      : { jobs: [running] }], "write exactly the surviving history and only the required focus repair");
    const expectedActive = removesFocus ? null : "running";
    assert.deepEqual(h.data, { jobs: [running], active: expectedActive },
      "persist repaired or preserved focus alongside the surviving job");
    assert.equal(result.activeJobId, expectedActive,
      "report the repaired or preserved active identity from single-key storage");
    assert.equal(result.removed, 1);
  });
}

for (const type of ["cancel", "clear-settings-terminal"]) {
  test(`external ${type} sanitizes every survivor before truncation and approval admission`, async () => {
    const boundary = "ordinary ".repeat(33).slice(0, 291) + " " + "ghp_" + "x".repeat(24);
    const siblings = Array.from({ length: 44 }, (_, i) => ({ id: `safe-${i}`, status: "approval",
      goal: boundary, summary: traceSecret, artifacts: [{ note: traceSecret }],
      pendingApproval: { step: { text: 'password="' + "x".repeat(4100) + '"' } } }));
    siblings[0].pageLock = { tabId: 2, url: "https://example.test/?token=private" };
    siblings[1].preflightDecision = { id: "token=private", siteKey: "example.test" };
    const h = externalHarness([{ id: "target", status: type === "cancel" ? "running" : "completed" }, ...siblings]);
    await h.mutate({ type, jobId: "target" });
    const saved = h.data.jobs.filter((job) => job.id !== "target");
    assert.deepEqual(saved.map((job) => job.id), siblings.map((job) => job.id), "retain over forty survivors in order");
    for (const job of saved) {
      assert.equal(job.goal, "ordinary ".repeat(33).slice(0, 291) + " [REDACTE");
      assert.equal(job.summary, traceClean); assert.equal(job.artifacts[0].note, traceClean);
      assert.equal(job.pendingApproval, null, "original oversized approval cannot become admitted after redaction");
    }
    assert.equal(saved[0].pageLock, null); assert.equal(saved[0].status, "paused");
    assert.equal(saved[1].preflightDecision, null); assert.equal(saved[1].status, "paused");
    for (const write of h.writes) assert.doesNotMatch(JSON.stringify(write), /synthetic|private|ghp_/);
  });
}

test("external mutation identities remain unique, reserve removed IDs, and remap focus", async () => {
  const input = [{ id: "job-redacted-1", status: "completed" }, { id: "token=private", status: "running" },
    { id: "duplicate", status: "paused" }, { id: "duplicate", status: "paused" },
    { status: "paused" }, { id: "", status: "paused" }, { id: "safe", status: "paused" }];
  for (let run = 0; run < 2; run++) {
    const h = externalHarness(structuredClone(input), "token=private");
    await h.mutate({ type: "clear-settings-terminal" });
    const ids = h.data.jobs.map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every(Boolean));
    assert.equal(ids[0], "job-redacted-2", "allocator is operation-local and reserves removed records");
    assert.equal(h.data.active, ids[0]); assert.equal(ids.at(-1), "safe");
  }
  for (const active of [null, "absent", "duplicate", "target"]) {
    const h = externalHarness([{ id: "target", status: "running" }, ...input], active);
    await h.mutate({ type: "cancel", jobId: "target" });
    assert.equal(h.data.active, "target", "cancel repairs missing or ambiguous focus");
  }
  for (const active of ["safe", "token=private"]) {
    const h = externalHarness([{ id: "target", status: "running" }, ...input], active);
    await h.mutate({ type: "cancel", jobId: "target" });
    assert.equal(h.data.active, active === "safe" ? "safe" : h.data.jobs[2].id,
      "cancel preserves and remaps a different uniquely focused record");
  }
  const unsafe = externalHarness([{ id: "token=private", status: "running" }]);
  const cancelled = await unsafe.mutate({ type: "cancel", jobId: "token=private" });
  assert.equal(cancelled.job.id, "job-redacted-1"); assert.equal(cancelled.activeJobId, cancelled.job.id);
  const missing = externalHarness([{ id: "safe", status: "running" }]);
  assert.equal((await missing.mutate({ type: "cancel", jobId: "absent" })).changed, false);
  assert.equal(missing.writes.length, 0);
  for (const active of ["absent", "duplicate", "job-redacted-1"]) {
    const h = externalHarness(structuredClone(input), active);
    await h.mutate({ type: "clear-settings-terminal" }); assert.equal(h.data.active, null);
  }
  const h = externalHarness(input);
  await assert.rejects(() => h.mutate({ type: "cancel", jobId: "duplicate" }));
  assert.equal(h.writes.length, 0);
});

test("external mutations refuse unknown history without touching stored records", async () => {
  for (const mutation of [
    { type: "clear-settings-terminal" },
    { type: "cancel", jobId: "running" },
    { type: "focus", jobId: "running", command: "jobs focus" }
  ]) {
    for (const envelope of [{}, { active: "running" }, { jobs: undefined }, { jobs: null }]) {
      const h = externalHarness([{ id: "running", status: "running" }], "running");
      const original = structuredClone(h.data);
      h.storage.get = async () => envelope;
      const outcome = await h.mutate(mutation).then(() => null, (error) => error);
      assert.deepEqual(h.data, original, "unknown history must leave stored records untouched");
      assert.equal(h.writes.length, 0, "unknown history must never write");
      assert.match(outcome?.message ?? "", /history could not be read safely/);
    }
  }
});

test("external clear accepts explicitly empty history", async () => {
  const h = externalHarness([]);
  assert.equal((await h.mutate({ type: "clear-settings-terminal" })).removed, 0);
  assert.deepEqual(h.data.jobs, []);
});

test("external mutation failures write nothing and queue processing recovers", { timeout: 2000 }, async () => {
  const badRecord = { id: "bad", status: "paused", get goal() { throw new Error("private preparation"); } };
  for (const stored of [null, [], "bad", { jobs: {} }, { jobs: [null] }, { jobs: [[]] }, { jobs: [3] }, { jobs: [badRecord] }]) {
    const h = externalHarness(); h.storage.get = () => stored;
    await assert.rejects(() => h.mutate({ type: "clear-settings-terminal" }), (error) => !/private/.test(error.message));
    assert.equal(h.writes.length, 0);
  }
  for (const mode of ["throw", "reject", "missing-get", "missing-set"]) {
    const h = externalHarness();
    if (mode === "throw") h.storage.get = () => { throw new Error("private read"); };
    if (mode === "reject") h.storage.get = () => Promise.reject(new Error("private read"));
    if (mode === "missing-get") delete h.storage.get;
    if (mode === "missing-set") delete h.storage.set;
    await assert.rejects(() => h.mutate({ type: "clear-settings-terminal" }), (error) => !/private/.test(error.message));
    assert.equal(h.writes.length, 0);
  }
  const h = externalHarness([{ id: "target", status: "running" }]);
  const save = h.storage.set; h.storage.set = async () => { throw new Error("private commit"); };
  await assert.rejects(() => h.mutate({ type: "cancel", jobId: "target" }), (error) => !/private/.test(error.message));
  h.storage.set = save;
  assert.equal((await h.mutate({ type: "cancel", jobId: "target" })).changed, true);
});

async function boundedMutationWait(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("External mutation did not settle")), 500);
    })]);
  } finally { clearTimeout(timer); }
}

for (const rejectFirst of [false, true]) {
  test(`queued helper mutations wait for commit settlement (reject=${rejectFirst})`, { timeout: 2000 }, async () => {
    const h = externalHarness([{ id: "a", status: "running" }, { id: "b", status: "running" }]);
    const gate = Promise.withResolvers(); const started = Promise.withResolvers(); const save = h.storage.set;
    let firstWrite = true;
    h.storage.set = async (value) => {
      if (firstWrite) { firstWrite = false; started.resolve(); await gate.promise; }
      await save(value);
    };
    const first = h.mutate({ type: "cancel", jobId: "a" });
    const outcome = first.then((value) => value, () => null);
    await boundedMutationWait(started.promise);
    const second = jobStorageModule.mutateBrowserJobStorage({ storage: h.storage, storageKeys: externalKeys,
      mutation: { type: "cancel", jobId: "b" } });
    try {
      await Promise.resolve(); assert.equal(h.reads(), 1, "second caller must not read before first commit");
      const independent = externalHarness([{ id: "c", status: "running" }]);
      assert.equal((await boundedMutationWait(independent.mutate({ type: "cancel", jobId: "c" }))).changed, true);
      h.data.other = [{ id: "d", status: "running" }];
      assert.equal((await boundedMutationWait(h.mutate({ type: "cancel", jobId: "d" }, {
        storageKeys: { ...externalKeys, browserJobs: "other" } }))).changed, true);
    } finally { if (rejectFirst) gate.reject(new Error("private")); else gate.resolve(); }
    await boundedMutationWait(outcome); const result = await boundedMutationWait(second);
    assert.deepEqual(h.data.jobs.map((job) => job.status), [rejectFirst ? "running" : "cancelled", "cancelled"]);
    const submitted = structuredClone(h.writes.at(-1)); result.job.goal = "mutated result";
    assert.deepEqual(h.writes.at(-1), submitted, "returned result must not alias submitted records");
  });
}

for (const type of ["cancel", "clear-settings-terminal"]) {
  test(`external ${type} quarantines unknown statuses without creating runnable work`, async () => {
    const h = externalHarness([{ id: "target", status: type === "cancel" ? "unknown" : "completed" },
      ...[undefined, "mystery"].map((status, i) => ({ id: `unknown-${i}`, status,
        pageLock: { tabId: 2 }, pendingApproval: { step: { type: "click" } }, preflightDecision: { id: "safe" } }))]);
    await h.mutate({ type, jobId: "target" });
    for (const job of h.data.jobs.filter((job) => job.id !== "target")) {
      assert.equal(job.status, "paused"); assert.equal(job.pageLock, null);
      assert.equal(job.pendingApproval, null); assert.equal(job.preflightDecision, null);
      assert.equal(job.lastError, "Saved job status was invalid. Review this job before continuing.");
    }
    if (type === "cancel") assert.equal(h.data.jobs[0].status, "cancelled");
    assert.equal(browserJobSchedulerState(h.data.jobs).runnableQueued.length, 0);
    const hydrated = createHarness(structuredClone(h.data)); await hydrated.store.hydrate();
    assert.equal(hydrated.store.getSchedulerState().runnableQueued.length, 0);
    await h.mutate({ type: "clear-settings-terminal" });
    assert.deepEqual(h.data.jobs.map((job) => job.id), ["unknown-0", "unknown-1"]);
  });
}
