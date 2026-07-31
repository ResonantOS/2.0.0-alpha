import assert from "node:assert/strict";
import test from "node:test";

import { controlStepLabel } from "../resonantos-side-panel-extension/src/lib/agent-control-planner.js";
import { createControlReportingService } from "../resonantos-side-panel-extension/src/lib/control-reporting-service.js";

function createHarness(overrides = {}) {
  const events = [];
  let currentControlRun = Object.hasOwn(overrides, "currentControlRun") ? overrides.currentControlRun : {
    id: "job-1",
    goal: "find a booking slot",
    planner: "observe-act-verify-loop",
    startedAt: "2026-05-26T10:00:00.000Z",
    summary: "Observe and act",
    status: "approval",
    timing: { durationMs: 2250 },
    steps: [
      { type: "read", state: "completed", timing: { durationMs: 900 }, details: { confidence: "high" } },
      { type: "click", text: "Submit", state: "blocked", details: { confidence: "low", uncertainty: "Public submit boundary.", nextHumanAction: "Review the form before approval." } }
    ],
    pageLock: { tabId: 7, siteKey: "manoloremiddi.com", url: "https://manoloremiddi.com/booking", reason: "Agent Control goal: find a booking slot" }
  };
  let lastSnapshot = overrides.lastSnapshot ?? {
    title: "Booking",
    url: "https://manoloremiddi.com/booking"
  };
  let pendingApproval = overrides.pendingApproval ?? {
    step: { type: "click", text: "Submit" },
    reason: "Public submit requires approval."
  };
  const service = createControlReportingService({
    addMessage: async (role, content) => events.push(["message", role, content]),
    bridgeRequest: async (path, request) => {
      events.push(["bridge", path, request.body]);
      if (overrides.bridgeError) throw new Error(overrides.bridgeError);
      if (path === "/archive/intake") return { path: "/archive/browser-report.md" };
      if (path === "/addons/delegate") return { target: "engineer", id: "delegation-1" };
      throw new Error(`Unexpected bridge path ${path}`);
    },
    controlStepLabel,
    getCurrentControlRun: () => currentControlRun,
    getLastSnapshot: () => lastSnapshot,
    getPendingApproval: () => pendingApproval
  });
  return {
    events,
    service,
    setCurrentControlRun: (run) => {
      currentControlRun = run;
    },
    setLastSnapshot: (snapshot) => {
      lastSnapshot = snapshot;
    },
    setPendingApproval: (approval) => {
      pendingApproval = approval;
    }
  };
}

test("control reporting service builds browser control reports with boundaries", () => {
  const harness = createHarness();

  const report = harness.service.buildControlReport([
    { step: { type: "click", text: "Continue", timing: { durationMs: 500 }, details: { approvalDecision: "approved-once", confidence: "medium", verificationRetry: "settle-reread", actionRetry: "precise-ref-retry" } }, result: { ok: true } },
    { step: { type: "click", text: "Submit", details: { strategyPhase: "Stop before public submission.", strategyRationale: "Use booking runbook.", completionCheck: "Visible page proves the booking is ready.", scenarioName: "Booking discovery", preferredProbes: ["Read available slots"], successSignals: ["Visible available slot"], stopConditions: ["Public submit required"], confidence: "low", uncertainty: "Public submit boundary.", ambiguousTarget: true, targetCandidates: [{ ref: "r1", label: "Submit", tagName: "button", approvalRequired: true }], nextHumanAction: "Review the form, then approve once or deny.", recoveryOptions: ["Review visible form fields before approval."] } }, result: { ok: false, approvalRequired: true, error: "approval needed" } }
  ], "approval-required");

  assert.match(report, /# Browser Agent Control Report/);
  assert.match(report, /find a booking slot/);
  assert.match(report, /duration: 2\.3 sec/);
  assert.match(report, /## Controlled Target/);
  assert.match(report, /targetSite: manoloremiddi\.com/);
  assert.match(report, /targetTab: 7/);
  assert.match(report, /## Aggregate Progress/);
  assert.match(report, /phase: approval/);
  assert.match(report, /summary: Awaiting approval · 1\/2 complete · 2\/2 resolved · 1 blocked · 50%/);
  assert.match(report, /Click "Continue" — ok · 500 ms · confidence: medium/);
  assert.match(report, /approval decision: approved-once/);
  assert.match(report, /verification retry: settle-reread/);
  assert.match(report, /action retry: precise-ref-retry/);
  assert.match(report, /Click "Submit" — approval-required · confidence: low — approval needed/);
  assert.match(report, /strategy phase: Stop before public submission/);
  assert.match(report, /strategy rationale: Use booking runbook/);
  assert.match(report, /completion check: Visible page proves the booking is ready/);
  assert.match(report, /scenario: Booking discovery/);
  assert.match(report, /success signal 1: Visible available slot/);
  assert.match(report, /stop boundary 1: Public submit required/);
  assert.match(report, /preferred probe 1: Read available slots/);
  assert.match(report, /uncertainty: Public submit boundary/);
  assert.match(report, /ambiguous target: yes/);
  assert.match(report, /target candidate 1: Submit · #r1 · approval-required/);
  assert.match(report, /next human action: Review the form, then approve once or deny/);
  assert.match(report, /recovery 1: Review visible form fields before approval/);
  assert.match(report, /Wallet, credential, public-submit, payment, and destructive actions/);
});

test("control reporting service redacts secret-like values from reports", () => {
  const harness = createHarness({
    currentControlRun: {
      id: "job-1",
      goal: "book with password=hunter2secret and pin: 9876",
      planner: "observe-act-verify-loop",
      startedAt: "2026-05-26T10:00:00.000Z",
      summary: "Observe and act",
      status: "completed",
      timing: { durationMs: 1000 },
      steps: [
        { type: "type", field: "Search", state: "completed", note: 'typed "vintage synths"', details: { confidence: "high" } },
        { type: "click", text: "Submit", state: "blocked", note: "auth token 7f3c9a1b2d4e5f68790a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f", details: { confidence: "low" } }
      ],
      pageLock: { tabId: 7, siteKey: "example.test", url: "https://example.test/login?token=abc123&email=a@b.com", reason: "Agent Control goal" }
    }
  });

  const report = harness.service.buildControlReport([
    { step: { type: "type", field: "Search", state: "completed", note: 'typed "vintage synths"' }, result: { ok: true } },
    { step: { type: "click", text: "Submit", state: "blocked" }, result: { ok: false, error: "auth token 7f3c9a1b2d4e5f68790a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f" } }
  ], "blocked");

  assert.match(report, /password=REDACTED/);
  assert.doesNotMatch(report, /hunter2secret/);
  assert.match(report, /pin: REDACTED/);
  assert.match(report, /token=REDACTED/);
  assert.doesNotMatch(report, /abc123/);
  assert.match(report, /email=a@b\.com/);
  assert.match(report, /\[REDACTED-TOKEN\]/);
  assert.doesNotMatch(report, /7f3c9a1b/);
});

test("control reporting service redacts secrets from job reports and delegation packets", async () => {
  const harness = createHarness({
    pendingApproval: {
      step: { type: "click", text: "Submit" },
      reason: "Public submit requires approval with token=xyz789"
    }
  });
  const job = {
    id: "job-2",
    goal: "compare a product",
    status: "blocked",
    planner: "observe-act-verify-loop",
    createdAt: "2026-05-26T09:00:00.000Z",
    updatedAt: "2026-05-26T09:02:00.000Z",
    timing: { durationMs: 122000 },
    summary: "Observed and compared",
    pageLock: { tabId: 12, siteKey: "example.com", url: "https://example.com/session?session=abc", reason: "Product comparison task" },
    steps: [
      { label: "Read page", state: "completed", note: "read product page", timing: { durationMs: 1500 }, details: { confidence: "high" } },
      { label: "Click details", state: "blocked", note: "clicked details", details: { confidence: "low", nextHumanAction: "Focus the correct product row before resuming." } }
    ],
    artifacts: []
  };

  const report = harness.service.buildBrowserJobReport(job);
  assert.match(report, /session=REDACTED/);
  assert.doesNotMatch(report, /abc/);

  await harness.service.delegateControlIssue();
  const bridgeCall = harness.events.find((event) => event[0] === "bridge");
  assert.match(bridgeCall[2].contextMarkdown, /token=REDACTED/);
  assert.doesNotMatch(bridgeCall[2].contextMarkdown, /xyz789/);
  assert.match(bridgeCall[2].mission, /token=REDACTED/);
  assert.doesNotMatch(bridgeCall[2].mission, /xyz789/);
});

test("control reporting service saves reports to archive intake", async () => {
  const harness = createHarness();

  const result = await harness.service.saveControlReportToArchive([
    { step: { type: "read" }, result: { ok: true } }
  ], "completed");

  assert.deepEqual(result, { path: "/archive/browser-report.md" });
  const bridgeCall = harness.events.find((event) => event[0] === "bridge");
  assert.equal(bridgeCall[1], "/archive/intake");
  assert.equal(bridgeCall[2].sourceMessageId, "job-1");
  assert.equal(bridgeCall[2].url, "https://manoloremiddi.com/booking");
  assert.match(bridgeCall[2].title, /Browser control completed/);
  assert.match(bridgeCall[2].content, /Read active page — ok/);
});

test("control reporting service builds and saves durable browser job reports", async () => {
  const harness = createHarness();
  const job = {
    id: "job-2",
    goal: "compare a product",
    status: "completed",
    planner: "observe-act-verify-loop",
    createdAt: "2026-05-26T09:00:00.000Z",
    updatedAt: "2026-05-26T09:02:00.000Z",
    timing: { durationMs: 122000 },
    summary: "Observed and compared",
    preflightDecision: {
      mode: "skipped-by-consent",
      siteKey: "example.com",
      taskClass: "shopping",
      permissionMode: "trusted-for-safe-actions",
      source: "task-consent-store",
      decidedAt: "2026-05-26T08:59:00.000Z",
      reason: "Stored safe task-class consent allowed preflight skip."
    },
    pageLock: { tabId: 12, siteKey: "example.com", url: "https://example.com/product", reason: "Product comparison task" },
    steps: [
      { label: "Read page", state: "completed", note: "read product page", timing: { durationMs: 1500 }, details: { confidence: "high" } },
      { label: "Click details", state: "blocked", note: "clicked details", details: { confidence: "low", uncertainty: "Repeated details controls.", nextHumanAction: "Focus the correct product row before resuming." } }
    ],
    artifacts: [{ type: "archive-intake", path: "/archive/existing.md" }]
  };

  const report = harness.service.buildBrowserJobReport(job);
  assert.match(report, /# Browser Job Report/);
  assert.match(report, /compare a product/);
  assert.match(report, /## Preflight Decision/);
  assert.match(report, /mode: skipped-by-consent/);
  assert.match(report, /taskClass: shopping/);
  assert.match(report, /duration: 2 min 2 sec/);
  assert.match(report, /targetSite: example\.com/);
  assert.match(report, /targetReason: Product comparison task/);
  assert.match(report, /phase: completed/);
  assert.match(report, /summary: Completed · 1\/2 complete · 2\/2 resolved · 1 blocked · 50%/);
  assert.match(report, /blockedSteps: 1/);
  assert.match(report, /Read page — completed · 1\.5 sec · confidence: high — read product page/);
  assert.match(report, /Click details — blocked · confidence: low — clicked details/);
  assert.match(report, /next human action: Focus the correct product row before resuming/);
  assert.match(report, /archive-intake: \/archive\/existing\.md/);

  const result = await harness.service.saveBrowserJobReportToArchive(job);
  assert.deepEqual(result, { path: "/archive/browser-report.md" });
  const bridgeCall = harness.events.find((event) => event[0] === "bridge");
  assert.equal(bridgeCall[1], "/archive/intake");
  assert.equal(bridgeCall[2].sourceMessageId, "job-2");
  assert.match(bridgeCall[2].title, /Browser job completed/);
  assert.match(bridgeCall[2].content, /# Browser Job Report/);
});

test("control reporting service returns null when no run exists", async () => {
  const harness = createHarness({ currentControlRun: null });

  assert.equal(harness.service.buildControlReport([], "completed"), "");
  assert.equal(await harness.service.saveControlReportToArchive([], "completed"), null);
});

test("control reporting service delegates blocked control issues to Engineer", async () => {
  const harness = createHarness();

  await harness.service.delegateControlIssue();

  const bridgeCall = harness.events.find((event) => event[0] === "bridge");
  assert.equal(bridgeCall[1], "/addons/delegate");
  assert.equal(bridgeCall[2].target, "engineer");
  assert.equal(bridgeCall[2].source, "browser-control-blocker");
  assert.equal(bridgeCall[2].sourceControlRunId, "job-1");
  assert.match(bridgeCall[2].mission, /find a booking slot/);
  assert.match(bridgeCall[2].mission, /Blocked step: Click "Submit"/);
  assert.match(bridgeCall[2].contextMarkdown, /# Browser Control Delegation Context/);
  assert.match(bridgeCall[2].contextMarkdown, /controlRunId: job-1/);
  assert.match(bridgeCall[2].contextMarkdown, /targetSite: manoloremiddi\.com/);
  assert.match(bridgeCall[2].contextMarkdown, /blockedStep: Click "Submit"/);
  assert.match(bridgeCall[2].contextMarkdown, /Review the form before approval/);
  assert.match(bridgeCall[2].contextMarkdown, /provider routing, wallet actions, credentials/);
  assert.ok(harness.events.some((event) => event[0] === "message" && /Delegated blocked control task/.test(event[2])));
});

test("control reporting service reports delegation failures", async () => {
  const harness = createHarness({ bridgeError: "delegate down" });

  await harness.service.delegateControlIssue();

  assert.ok(harness.events.some((event) => event[0] === "message" && /Delegation failed: delegate down/.test(event[2])));
});
