import assert from "node:assert/strict";
import test from "node:test";

import { createControlRunState } from "../resonantos-side-panel-extension/src/lib/control-run-state.js";

function createHarness(overrides = {}) {
  const events = [];
  let activeJobId = overrides.activeJobId ?? "job-a";
  let currentControlRun = overrides.currentControlRun ?? null;
  let pendingApproval = { step: { type: "click", text: "Submit" } };
  let nowValue = overrides.nowMs ?? 1_000;
  const timers = [];
  const state = createControlRunState({
    browserJobStore: {
      findJob: (id) => overrides.persistedJobs?.[id] ?? null,
      getActiveJobId: () => activeJobId
    },
    getCurrentControlRun: () => currentControlRun,
    minimumOverlayMs: overrides.minimumOverlayMs,
    nowMs: () => nowValue,
    renderControlMonitor: () => events.push(["render"]),
    setCurrentControlRun: (run) => {
      currentControlRun = run;
      events.push(["run", run?.status ?? null]);
    },
    setPageControlOverlay: async (active, label, phase) => events.push(["overlay", active, label, phase]),
    setPendingApproval: (approval) => {
      pendingApproval = approval;
      events.push(["pending", approval]);
    },
    setTimeoutFn: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    updateBrowserJob: async (id, patch) => events.push(["job", id, patch])
  });
  return {
    events,
    getCurrentControlRun: () => currentControlRun,
    getPendingApproval: () => pendingApproval,
    runTimers: () => {
      const pending = timers.splice(0);
      pending.forEach((timer) => timer.callback());
      return pending;
    },
    setActiveJobId: (id) => {
      activeJobId = id;
    },
    setNowMs: (value) => {
      nowValue = value;
    },
    state
  };
}

test("control run state starts a run with active job id and overlay", () => {
  const harness = createHarness();

  const run = harness.state.startControlRun({
    goal: "find booking",
    plan: {
      source: "planner",
      summary: "read and click",
      pageLock: { tabId: 9, siteKey: "example.test", url: "https://example.test/", reason: "test target" },
      steps: [{ type: "read" }, { type: "click", text: "Book" }]
    }
  });

  assert.equal(run.id, "job-a");
  assert.equal(run.pageLock.siteKey, "example.test");
  assert.equal(harness.getPendingApproval(), null);
  assert.equal(run.timing.startedAtMs, 1_000);
  assert.deepEqual(harness.getCurrentControlRun().steps.map((step) => step.state), ["pending", "pending"]);
  assert.ok(harness.events.some((event) => event[0] === "render"));
  assert.ok(harness.events.some((event) => event[0] === "overlay" && event[1] === true && /find booking/.test(event[2]) && event[3] === "working"));
});

test("control run state preserves resumed job steps and artifacts", () => {
  const harness = createHarness({ activeJobId: "job-resume" });

  const run = harness.state.startControlRun({
    goal: "resume booking",
    plan: {
      source: "planner",
      summary: "continue same durable job",
      pageLock: { tabId: 3, siteKey: "example.com", url: "https://example.com/", reason: "resume target" },
      artifacts: [{ type: "archive-intake", path: "/old.md" }],
      steps: [{ type: "read", label: "Read page", state: "completed", note: "already read" }]
    }
  });

  assert.equal(run.id, "job-resume");
  assert.equal(run.steps[0].state, "completed");
  assert.equal(run.steps[0].note, "already read");
  assert.deepEqual(run.artifacts, [{ type: "archive-intake", path: "/old.md" }]);
  assert.equal(run.pageLock.reason, "resume target");
});


test("control run state appends and updates steps immutably", () => {
  const harness = createHarness({
    currentControlRun: {
      id: "job-a",
      steps: [{ type: "read", state: "pending" }],
      artifacts: []
    }
  });

  const index = harness.state.appendControlStep({ type: "click", text: "Next" });
  harness.setNowMs(1_250);
  harness.state.updateControlStep(1, "active", "Clicking");
  harness.setNowMs(1_600);
  harness.state.updateControlStep(1, "completed", "Clicked");

  assert.equal(index, 1);
  assert.equal(harness.getCurrentControlRun().steps.length, 2);
  assert.equal(harness.getCurrentControlRun().steps[1].state, "completed");
  assert.equal(harness.getCurrentControlRun().steps[1].note, "Clicked");
  assert.equal(harness.getCurrentControlRun().steps[1].timing.startedAtMs, 1_250);
  assert.equal(harness.getCurrentControlRun().steps[1].timing.completedAtMs, 1_600);
  assert.equal(harness.getCurrentControlRun().steps[1].timing.durationMs, 350);
});

test("control run state updates the page overlay with active and blocked step labels", () => {
  const harness = createHarness({
    currentControlRun: {
      id: "job-a",
      steps: [
        { type: "read", state: "pending" },
        { type: "click", text: "Reserve", state: "pending" }
      ],
      artifacts: []
    }
  });

  harness.state.updateControlStep(0, "active", "Reading visible content");
  harness.state.updateControlStep(1, "blocked", "Click requires approval");

  assert.ok(harness.events.some((event) =>
    event[0] === "overlay" &&
    event[1] === true &&
    event[2] === "reading" &&
    event[3] === "reading"
  ));
  assert.ok(harness.events.some((event) =>
    event[0] === "overlay" &&
    event[1] === true &&
    event[2] === "Blocked: Clicking Reserve: Click requires approval" &&
    event[3] === "blocked"
  ));
});

test("control run state uses plain public action labels without changing step detail", () => {
  const stepTypes = [
    ["read", "reading", "reading"],
    ["inspect", "reading", "reading"],
    ["forms", "reading", "reading"],
    ["tabs", "reading", "reading"],
    ["open", "reading", "reading"],
    ["search", "reading", "reading"],
    ["switch_tab", "reading", "reading"],
    ["click", "clicking", "clicking"],
    ["scroll", "clicking", "clicking"],
    ["type", "typing", "typing"],
    ["wait", "waiting for you", "waiting"]
  ];
  const harness = createHarness({
    currentControlRun: {
      id: "job-a",
      steps: stepTypes.map(([type]) => ({ type, text: "example", state: "pending" })),
      artifacts: []
    }
  });

  stepTypes.forEach(([_type, _label, _phase], index) => {
    harness.state.updateControlStep(index, "active", `internal note ${index}`);
  });

  const overlayEvents = harness.events.filter((event) => event[0] === "overlay");
  assert.deepEqual(
    overlayEvents.map((event) => [event[2], event[3]]),
    stepTypes.map(([_type, label, phase]) => [label, phase])
  );
  assert.deepEqual(
    harness.getCurrentControlRun().steps.map((step) => step.note),
    stepTypes.map((_entry, index) => `internal note ${index}`)
  );
});

test("control run state ignores step updates when no run or index exists", () => {
  const harness = createHarness();

  assert.equal(harness.state.appendControlStep({ type: "read" }), -1);
  harness.state.updateControlStep(0, "active");

  assert.equal(harness.getCurrentControlRun(), null);
});

test("control run state updates artifacts without finishing", () => {
  const harness = createHarness({
    currentControlRun: {
      id: "job-a",
      steps: [],
      artifacts: []
    }
  });

  harness.state.updateControlRunArtifacts([{ type: "archive-intake", path: "/archive.md" }]);

  assert.deepEqual(harness.getCurrentControlRun().artifacts, [{ type: "archive-intake", path: "/archive.md" }]);
});

test("control run state finishes run, clears overlay, and syncs browser job", async () => {
  const harness = createHarness({
    minimumOverlayMs: 0,
    currentControlRun: {
      id: "job-a",
      planner: "planner",
      summary: "summary",
      pageLock: { tabId: 9, siteKey: "example.test", url: "https://example.test/", reason: "finish target" },
      steps: [],
      artifacts: [{ type: "existing", path: "/old.md" }]
    }
  });

  harness.state.finishControlRun("completed", { type: "archive-intake", path: "/new.md" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.getCurrentControlRun().status, "completed");
  assert.ok(harness.getCurrentControlRun().completedAt);
  assert.ok(harness.getCurrentControlRun().timing.completedAt);
  assert.deepEqual(harness.getCurrentControlRun().artifacts.map((artifact) => artifact.path), ["/old.md", "/new.md"]);
  assert.ok(harness.events.some((event) => event[0] === "overlay" && event[1] === false && event[3] === "returning"));
  assert.ok(harness.events.some((event) =>
    event[0] === "job" &&
    event[1] === "job-a" &&
    event[2].status === "completed" &&
    event[2].planner === "planner" &&
    event[2].pageLock.siteKey === "example.test" &&
    event[2].timing.completedAt
  ));
});

test("control run state records the stopped step when cancelled", async () => {
  const harness = createHarness({
    minimumOverlayMs: 0,
    currentControlRun: {
      id: "job-a",
      planner: "planner",
      summary: "summary",
      pageLock: { tabId: 9, siteKey: "example.test", url: "https://example.test/", reason: "cancel target" },
      steps: [
        { type: "read", state: "completed", note: "read page" },
        { type: "click", text: "Reserve", state: "active" },
        { type: "type", field: "Name", state: "pending" }
      ],
      artifacts: []
    }
  });

  harness.state.finishControlRun("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.getCurrentControlRun().status, "cancelled");
  assert.equal(harness.getCurrentControlRun().steps[1].state, "cancelled");
  assert.equal(harness.getCurrentControlRun().steps[1].note, "Stopped by human.");
  assert.match(harness.getCurrentControlRun().steps[1].details.nextHumanAction, /restart or resume/);
  assert.equal(harness.getCurrentControlRun().steps[2].state, "pending");
  assert.ok(harness.events.some((event) =>
    event[0] === "job" &&
    event[2].status === "cancelled" &&
    event[2].steps[1].state === "cancelled"
  ));
  assert.ok(harness.events.some((event) =>
    event[0] === "overlay" &&
    event[1] === true &&
    /Cancelled: Clicking Reserve/.test(event[2])
  ));
});

test("control run state preserves a human-stopped durable job from stale runner completion", async () => {
  const harness = createHarness({
    minimumOverlayMs: 0,
    persistedJobs: {
      "job-a": { id: "job-a", status: "cancelled" }
    },
    currentControlRun: {
      id: "job-a",
      planner: "planner",
      summary: "summary",
      pageLock: { tabId: 9, siteKey: "example.test", url: "https://example.test/", reason: "stale finish target" },
      steps: [{ type: "read", state: "completed", note: "read page" }],
      artifacts: []
    }
  });

  harness.state.finishControlRun("completed");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.getCurrentControlRun().status, "cancelled");
  assert.ok(harness.events.some((event) =>
    event[0] === "job" &&
    event[1] === "job-a" &&
    event[2].status === "cancelled"
  ));
});

test("control run state keeps short runs visibly active before clearing overlay", async () => {
  const harness = createHarness({ minimumOverlayMs: 900, nowMs: 1_000 });

  harness.state.startControlRun({
    goal: "quick read",
    plan: {
      source: "planner",
      summary: "short task",
      steps: [{ type: "read" }]
    }
  });
  harness.setNowMs(1_100);
  harness.state.finishControlRun("completed");

  assert.equal(harness.events.filter((event) => event[0] === "overlay" && event[1] === false).length, 0);
  const timers = harness.runTimers();
  assert.equal(timers[0].delay, 800);
  assert.ok(harness.events.some((event) => event[0] === "overlay" && event[1] === false && event[3] === "returning"));
});

test("control run state does not let an old delayed overlay release hide a newer run", async () => {
  const harness = createHarness({ minimumOverlayMs: 900, nowMs: 1_000 });

  harness.state.startControlRun({
    goal: "first task",
    plan: { source: "planner", summary: "first", steps: [] }
  });
  harness.setNowMs(1_100);
  harness.state.finishControlRun("completed");
  harness.setActiveJobId("job-b");
  harness.state.startControlRun({
    goal: "second task",
    plan: { source: "planner", summary: "second", steps: [] }
  });
  harness.runTimers();

  assert.equal(harness.events.filter((event) => event[0] === "overlay" && event[1] === false).length, 0);
  assert.ok(harness.events.some((event) => event[0] === "overlay" && event[1] === true && /second task/.test(event[2])));
});
