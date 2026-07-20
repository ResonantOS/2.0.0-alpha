import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  controlActionStateLabel,
  controlRunPhase,
  controlRunPhaseLabel,
  controlRunProgress,
  controlRunProgressSummary,
  controlRunSummary,
  createMonitorRenderers,
  formatDurationMs,
  sitePermissionDescription
} from "../resonantos-side-panel-extension/src/lib/monitor-renderers.js";

function createHarness(overrides = {}) {
  const dom = new JSDOM(`
    <section id="site" hidden>
      <strong id="host"></strong>
      <select id="mode">
        <option value="ask-before-action"></option>
        <option value="read-only"></option>
        <option value="trusted-for-safe-actions"></option>
        <option value="blocked"></option>
      </select>
      <p id="note"></p>
    </section>
    <section id="jobs" hidden>
      <strong id="jobs-title"></strong>
      <button id="jobs-toggle"></button>
      <ul id="jobs-list"></ul>
    </section>
    <section id="consents" hidden>
      <strong id="consents-title"></strong>
      <ol id="consents-list"></ol>
    </section>
    <section id="permission-manager" hidden>
      <strong id="permission-manager-title"></strong>
      <ol id="permission-manager-list"></ol>
    </section>
    <section id="control" hidden>
      <strong id="control-title"></strong>
      <span id="control-status"></span>
      <button id="control-stop"></button>
      <div id="control-current"><span></span><div><small></small><strong></strong></div></div>
      <div id="control-summary-card"></div>
      <ol id="control-steps"></ol>
      <div id="control-artifacts"></div>
    </section>
    <section id="approval" hidden>
      <strong id="approval-title"></strong>
      <p id="approval-reason"></p>
      <button id="approval-approve"></button>
      <button id="approval-allow-once"></button>
      <button id="approval-trust"></button>
    </section>
  `);
  globalThis.document = dom.window.document;
  const calls = [];
  const state = {
    browserJobs: overrides.browserJobs ?? [],
    activeJobId: overrides.activeJobId ?? "job-a",
    approved: [],
    contextDockExpanded: overrides.contextDockExpanded ?? true,
    cancelled: [],
    currentControlRun: overrides.currentControlRun ?? null,
    denied: [],
    jobMonitorCollapsed: overrides.jobMonitorCollapsed ?? true,
    paused: [],
    schedulerState: overrides.schedulerState ?? null,
    pendingApproval: overrides.pendingApproval ?? null,
    tab: overrides.tab ?? { url: "https://example.com/page" },
    continued: [],
    reported: [],
    resetSites: [],
    revoked: []
  };
  const renderers = createMonitorRenderers({
    activeTab: async () => state.tab,
    approvalBoundaryForStep: (step) => step.boundary ?? "safe",
    controlStepLabel: (step) => step.label ?? step.type,
    elements: {
      approvalAllowOnceButton: dom.window.document.querySelector("#approval-allow-once"),
      approvalApproveButton: dom.window.document.querySelector("#approval-approve"),
      approvalCard: dom.window.document.querySelector("#approval"),
      approvalReason: dom.window.document.querySelector("#approval-reason"),
      approvalTitle: dom.window.document.querySelector("#approval-title"),
      approvalTrustSiteButton: dom.window.document.querySelector("#approval-trust"),
      controlArtifacts: dom.window.document.querySelector("#control-artifacts"),
      controlCurrentAction: dom.window.document.querySelector("#control-current"),
      controlMonitor: dom.window.document.querySelector("#control"),
      controlSummaryCard: dom.window.document.querySelector("#control-summary-card"),
      controlMonitorStatus: dom.window.document.querySelector("#control-status"),
      controlMonitorTitle: dom.window.document.querySelector("#control-title"),
      controlStopButton: dom.window.document.querySelector("#control-stop"),
      controlStepList: dom.window.document.querySelector("#control-steps"),
      jobList: dom.window.document.querySelector("#jobs-list"),
      jobMonitor: dom.window.document.querySelector("#jobs"),
      jobMonitorTitle: dom.window.document.querySelector("#jobs-title"),
      jobMonitorToggle: dom.window.document.querySelector("#jobs-toggle"),
      permissionManagerList: dom.window.document.querySelector("#permission-manager-list"),
      permissionManagerPanel: dom.window.document.querySelector("#permission-manager"),
      permissionManagerTitle: dom.window.document.querySelector("#permission-manager-title"),
      sitePermissionHost: dom.window.document.querySelector("#host"),
      sitePermissionMode: dom.window.document.querySelector("#mode"),
      sitePermissionNote: dom.window.document.querySelector("#note"),
      sitePermissionPanel: dom.window.document.querySelector("#site"),
      taskConsentList: dom.window.document.querySelector("#consents-list"),
      taskConsentPanel: dom.window.document.querySelector("#consents"),
      taskConsentTitle: dom.window.document.querySelector("#consents-title")
    },
    getBrowserJobs: () => state.browserJobs,
    getActiveBrowserJobId: () => state.activeJobId,
    getBrowserJobSchedulerState: () => state.schedulerState,
    getContextDockExpanded: () => state.contextDockExpanded,
    getCurrentControlRun: () => state.currentControlRun,
    getJobMonitorCollapsed: () => state.jobMonitorCollapsed,
    getPendingApproval: () => state.pendingApproval,
    getSitePermissionAudit: async () => overrides.sitePermissionAudit ?? {},
    getSitePermissions: async () => overrides.sitePermissions ?? {},
    getTaskConsentAudit: async () => overrides.taskConsentAudit ?? {},
    getTaskConsents: async () => overrides.taskConsents ?? {},
    isReadableBrowserTab: (tab) => /^https?:\/\//i.test(tab?.url ?? ""),
    onContinueBrowserJob: (job) => state.continued.push(job.id),
    onActivateBrowserJob: (job) => {
      state.activeJobId = job.id;
      state.focused = [...(state.focused ?? []), job.id];
    },
    onApproveBrowserJob: (job) => state.approved.push(job.id),
    onCancelBrowserJob: (job) => state.cancelled.push(job.id),
    onDenyBrowserJob: (job) => state.denied.push(job.id),
    onPauseBrowserJob: (job) => state.paused.push(job.id),
    onSaveBrowserJobReport: (job) => state.reported.push(job.id),
    onResetSitePermission: (siteKey) => state.resetSites.push(siteKey),
    onRevokeTaskConsent: (consent) => state.revoked.push(consent.taskClass),
    permissionForUrl: async () => overrides.permission ?? "trusted-for-safe-actions",
    siteKeyForUrl: (url) => new URL(url).hostname.replace(/^www\./, ""),
    updateContextDockVisibility: () => calls.push("dock")
  });

  return {
    calls,
    dom,
    renderers,
    state
  };
}

test("monitor renderers describe site permission modes", () => {
  assert.match(sitePermissionDescription("blocked"), /Can see\/do now: nothing/);
  assert.match(sitePermissionDescription("read-only"), /page text, controls, fields, frames, and metadata/);
  assert.match(sitePermissionDescription("trusted-for-safe-actions"), /safe clicks, non-sensitive typing, scrolling, and search-like submits/);
  assert.match(sitePermissionDescription("ask-before-action"), /asks before risky clicks/);
  assert.match(sitePermissionDescription("ask-before-action"), /blocks wallet, login, payment, credential, and personal autofill/);
});

test("monitor renderers calculate control run progress", () => {
  assert.deepEqual(controlRunProgress({
    status: "running",
    steps: [{ state: "completed" }, { state: "active" }, { state: "pending" }]
  }), {
    active: 1,
    activeLabel: "step 2/3",
    blocked: -1,
    blockedCount: 0,
    completed: 1,
    currentStep: { state: "active" },
    failed: 0,
    label: "running · step 2/3",
    pending: 1,
    percent: 33,
    phase: "deciding",
    terminal: 1,
    total: 3
  });
  assert.equal(controlRunPhase({ status: "running", currentStep: { type: "read" } }), "reading");
  assert.equal(controlRunPhase({ status: "running", currentStep: { type: "click" } }), "acting");
  assert.equal(controlRunPhase({ status: "approval", currentStep: { type: "click" } }), "approval");
  assert.equal(controlRunPhase({ status: "cancelled", currentStep: { type: "click" } }), "cancelled");
  assert.equal(controlRunPhaseLabel("navigating"), "Navigating");
  assert.equal(controlRunPhaseLabel("cancelled"), "Stopped");
  assert.equal(controlRunProgressSummary({
    status: "running",
    steps: [{ state: "completed" }, { state: "active", type: "click" }, { state: "pending" }]
  }), "Acting · 1/3 complete · 1 queued · 33%");
  assert.equal(controlRunProgressSummary({
    status: "cancelled",
    steps: [{ state: "completed" }, { state: "cancelled", type: "click" }, { state: "pending" }]
  }), "Stopped · 1/3 complete · 2/3 resolved · 1 queued · 33%");
  assert.equal(controlActionStateLabel("active"), "working");
  assert.equal(controlActionStateLabel("completed"), "done");
  assert.equal(controlActionStateLabel("blocked"), "needs review");
  assert.equal(controlActionStateLabel("cancelled"), "stopped");
  assert.equal(formatDurationMs(450), "450 ms");
  assert.equal(formatDurationMs(1_250), "1.3 sec");
  assert.equal(formatDurationMs(12_400), "12 sec");
  assert.deepEqual(controlRunSummary({ status: "completed", steps: [{ state: "completed" }] }), {
    state: "completed",
    title: "Task completed",
    body: "1/1 actions completed. Review the trace below or save the report to Living Archive intake."
  });
  assert.match(controlRunSummary({
    status: "blocked",
    steps: [{ state: "blocked", details: { nextHumanAction: "Select the correct visible button." } }]
  }).body, /Select the correct visible button/);
});

test("monitor renderers hide control monitor when no run exists", () => {
  const harness = createHarness();

  harness.renderers.renderControlMonitor();

  assert.equal(harness.dom.window.document.querySelector("#control").hidden, true);
  assert.equal(harness.dom.window.document.querySelector("#approval").hidden, true);
  assert.deepEqual(harness.calls, ["dock"]);
});

test("monitor renderers render control steps, artifacts, and approval boundaries", () => {
  const harness = createHarness({
    currentControlRun: {
      goal: "find product",
      status: "approval",
      pageLock: { tabId: 44, siteKey: "example.com", url: "https://example.com/product", reason: "Agent Control goal: find product" },
      steps: [
        {
          type: "read",
          state: "completed",
          note: "saw page",
          details: {
            observation: { title: "Product page", url: "https://example.com/product" },
            decision: "Read first.",
            action: "Read page",
            approvalDecision: "approved-once",
            result: "saw page",
            safetyClass: "safe",
            strategyPhase: "Read the page.",
            strategyRationale: "Use product runbook.",
            completionCheck: "Visible product state proves the result.",
            scenarioName: "Shopping comparison",
            preferredProbes: ["Read product cards"],
            successSignals: ["Visible product options"],
            stopConditions: ["Checkout required"],
            confidence: "high",
            uncertainty: "None detected.",
            verificationRetry: "settle-reread",
            actionRetry: "precise-ref-retry",
            nextHumanAction: "No human action needed."
          },
          timing: { durationMs: 1250 }
        },
        { type: "click", label: "Click button", state: "blocked" }
      ],
      artifacts: [{ type: "report", path: "/tmp/report.md" }]
    },
    pendingApproval: {
      reason: "Click needs approval.",
      step: { type: "click", label: "Click button", boundary: "public-submit" }
    }
  });

  harness.renderers.renderControlMonitor();

  assert.equal(harness.dom.window.document.querySelector("#control").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#control-title").textContent, "find product");
  assert.equal(harness.dom.window.document.querySelector("#control-status").dataset.status, "approval");
  assert.equal(harness.dom.window.document.querySelector("#control-status").textContent, "approval · blocked at 2/2");
  assert.equal(harness.dom.window.document.querySelector("#control-stop").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#control-current").dataset.state, "blocked");
  assert.equal(harness.dom.window.document.querySelector("#control-current small").textContent, "Needs approval");
  assert.equal(harness.dom.window.document.querySelector("#control-current strong").textContent, "Click button");
  assert.match(harness.dom.window.document.querySelector(".control-target-meta").textContent, /Target: example\.com · tab 44/);
  assert.match(harness.dom.window.document.querySelector(".control-target-meta").textContent, /find product/);
  assert.match(harness.dom.window.document.querySelector(".control-phase-meta").textContent, /Awaiting approval/);
  assert.match(harness.dom.window.document.querySelector(".control-phase-meta").textContent, /1\/2 complete · 2\/2 resolved · 1 blocked · 50%/);
  assert.equal(harness.dom.window.document.querySelector(".control-progress-track").getAttribute("aria-label"), "Agent Control progress 50 percent");
  assert.equal(harness.dom.window.document.querySelector(".control-progress-track i").style.width, "50%");
  assert.equal(harness.dom.window.document.querySelector("#control-summary-card").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#control-summary-card").dataset.state, "approval");
  assert.match(harness.dom.window.document.querySelector("#control-summary-card").textContent, /Human approval needed/);
  assert.deepEqual([...harness.dom.window.document.querySelectorAll("#control-steps li")].map((item) => ({
    index: item.dataset.index,
    state: item.dataset.state,
    text: item.querySelector(".control-step-main").textContent,
    note: item.querySelector(".control-step-note")?.textContent ?? "",
    badge: item.querySelector(".control-step-state")?.textContent ?? ""
  })), [
    { index: "1", state: "completed", text: "read", note: "saw page", badge: "done" },
    { index: "2", state: "blocked", text: "Click button", note: "", badge: "needs review" }
  ]);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Observation/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /1\.3 sec/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Confidence/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /high/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Verification retry/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /settle-reread/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Action retry/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /precise-ref-retry/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Strategy phase/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Use product runbook/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Approval decision/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /approved-once/);
  assert.match(harness.dom.window.document.querySelector(".control-strategy-card").textContent, /Shopping comparison/);
  assert.match(harness.dom.window.document.querySelector(".control-strategy-card").textContent, /Visible product options/);
  assert.match(harness.dom.window.document.querySelector(".control-strategy-card").textContent, /Checkout required/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /Current authority/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /example\.com · tab 44/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /Can see/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /visible page text/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /Human-only/);
  assert.match(harness.dom.window.document.querySelector(".control-boundary-card").textContent, /wallet signing/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Preferred probes/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Next human action/);
  assert.match(harness.dom.window.document.querySelector(".control-step-detail").textContent, /Product page/);
  assert.match(harness.dom.window.document.querySelector("#control-artifacts").textContent, /report: \/tmp\/report\.md/);
  assert.equal(harness.dom.window.document.querySelector("#approval").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#approval-approve").disabled, false);
  assert.equal(harness.dom.window.document.querySelector("#approval-trust").disabled, true);
  assert.match(harness.dom.window.document.querySelector("#approval-reason").textContent, /Public-submit boundary/);
});

test("monitor renderers render collapsed and expanded browser jobs", () => {
  const browserJobs = [
    {
      id: "job-a",
      goal: "A task",
      status: "running",
      updatedAt: "2026-05-26T10:00:00.000Z",
      planner: "loop",
      pageLock: { tabId: 12, siteKey: "example.com", url: "https://example.com/", acquiredAt: "2026-05-26T10:00:00.000Z" }
    },
    {
      id: "job-b",
      goal: "B task",
      status: "blocked",
      updatedAt: "2026-05-26T09:00:00.000Z",
      planner: "loop",
      preflightDecision: {
        mode: "trusted-safe-actions",
        taskClass: "booking",
        siteKey: "example.com",
        reason: "Human trusted safe booking actions."
      },
      steps: [
        { state: "completed", label: "Read page", type: "read" },
        {
          state: "blocked",
          label: "Click Submit",
          type: "click",
          details: {
            actionRetry: "precise-ref-retry",
            ambiguousTarget: true,
            nextHumanAction: "Review the submit button before continuing.",
            targetCandidates: [
              { ref: "r1", label: "Submit", tagName: "button", approvalRequired: true },
              { ref: "r2", label: "Submit later", tagName: "button", approvalRequired: false }
            ],
            verificationRetry: "settle-reread"
          }
        }
      ]
    }
  ];
  const harness = createHarness({ browserJobs, jobMonitorCollapsed: true, activeJobId: "job-a" });

  harness.renderers.renderJobMonitor();

  assert.equal(harness.dom.window.document.querySelector("#jobs").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#jobs-title").textContent, "1 active · 2 total · focused job-a");
  assert.equal(harness.dom.window.document.querySelector("#jobs-toggle").textContent, "Show");
  assert.equal(harness.dom.window.document.querySelector("#jobs-list").hidden, true);

  harness.state.jobMonitorCollapsed = false;
  harness.renderers.renderJobMonitor();

  assert.equal(harness.dom.window.document.querySelector("#jobs-toggle").textContent, "Hide");
  assert.equal(harness.dom.window.document.querySelector("#jobs-list").hidden, false);
  assert.deepEqual([...harness.dom.window.document.querySelectorAll("#jobs-list > li")].map((item) => item.dataset.status), ["running", "blocked"]);
  assert.deepEqual([...harness.dom.window.document.querySelectorAll("#jobs-list > li")].map((item) => item.dataset.active), ["true", "false"]);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Focused browser job/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Lock: example\.com · tab 12/);
  assert.equal(harness.dom.window.document.querySelector("#jobs-list > li").dataset.attention, "stale");
  assert.match(harness.dom.window.document.querySelector(".job-stale-guidance").textContent, /Attention: Running job has no recent recorded progress/);
  assert.match(harness.dom.window.document.querySelector(".job-stale-guidance").textContent, /continue the job/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Preflight: trusted safe actions · booking · example\.com/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Progress: Blocked · 1\/2 complete · 2\/2 resolved · 1 blocked · 50%/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Recovery evidence: verification retry: settle-reread · action retry: precise-ref-retry/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Ambiguous target candidates: Submit · #r1 · approval-required; Submit later · #r2/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Next human action: Review the submit button before continuing/);
  assert.equal(harness.dom.window.document.querySelector(".job-blocker-guidance").textContent, "Next human action: Review the submit button before continuing.");
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /done · Read page/);
  [...harness.dom.window.document.querySelectorAll("#jobs-list > li:nth-child(2) .job-actions button")]
    .find((button) => button.textContent === "Focus")
    .click();
  assert.deepEqual(harness.state.focused, ["job-b"]);
  [...harness.dom.window.document.querySelectorAll("#jobs-list > li:nth-child(2) .job-actions button")]
    .find((button) => button.textContent === "Continue")
    .click();
  assert.deepEqual(harness.state.continued, ["job-b"]);
  [...harness.dom.window.document.querySelectorAll("#jobs-list > li:nth-child(2) .job-actions button")]
    .find((button) => button.textContent === "Report")
    .click();
  assert.deepEqual(harness.state.reported, ["job-b"]);
  [...harness.dom.window.document.querySelectorAll("#jobs-list > li:first-child .job-actions button")]
    .find((button) => button.textContent === "Pause")
    .click();
  assert.deepEqual(harness.state.paused, ["job-a"]);
  [...harness.dom.window.document.querySelectorAll("#jobs-list > li:first-child .job-actions button")]
    .find((button) => button.textContent === "Cancel")
    .click();
  assert.deepEqual(harness.state.cancelled, ["job-a"]);
});

test("monitor renderers expose scheduler state for queued browser jobs", () => {
  const browserJobs = [
    { id: "job-a", goal: "A task", status: "running", updatedAt: "2026-05-26T10:00:00.000Z", planner: "loop" },
    { id: "job-b", goal: "B task", status: "queued", updatedAt: "2026-05-26T09:00:00.000Z", planner: "loop" },
    { id: "job-c", goal: "C task", status: "queued", updatedAt: "2026-05-26T08:00:00.000Z", planner: "loop" }
  ];
  const harness = createHarness({
    activeJobId: "job-a",
    browserJobs,
    jobMonitorCollapsed: false,
    schedulerState: {
      activeSlots: 1,
      capacityBlockedQueued: [],
      lockBlockedQueued: [{ id: "job-c", goal: "C task", status: "queued", blockerId: "job-a", blockerGoal: "A task" }],
      maxConcurrent: 2,
      runnableQueued: [{ id: "job-b", goal: "B task", status: "queued" }]
    }
  });

  harness.renderers.renderJobMonitor();

  assert.equal(harness.dom.window.document.querySelector("#jobs-title").textContent, "3 active · 3 total · 1 runnable · 1 locked · focused job-a");
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Scheduler: runnable when the runner is available \(1\/2 active\)/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Scheduler: locked by job-a · A task/);
});

test("monitor renderers expose job-specific approval focus", () => {
  const browserJobs = [
    {
      id: "job-a",
      goal: "Running task",
      status: "running",
      updatedAt: "2026-05-26T10:00:00.000Z",
      planner: "loop"
    },
    {
      id: "job-approval",
      goal: "Submit reviewed form",
      status: "approval",
      updatedAt: "2026-05-26T10:01:00.000Z",
      planner: "loop",
      pendingApproval: {
        reason: "Public-submit boundary.",
        results: [],
        history: [{
          observation: {
            title: "Checkout Review",
            url: "https://shop.example/review"
          }
        }],
        stepIndex: 1,
        step: { type: "click", text: "Submit public form" }
      },
      pageLock: { tabId: 77, siteKey: "shop.example", url: "https://shop.example/review", reason: "Agent Control goal: submit reviewed form" },
      steps: [
        { state: "completed", label: "Read form", type: "read" },
        {
          state: "blocked",
          label: "Submit public form",
          type: "click",
          details: { nextHumanAction: "Focus this browser job, review the page, then approve once or deny." }
        }
      ]
    }
  ];
  const harness = createHarness({
    activeJobId: "job-a",
    browserJobs,
    jobMonitorCollapsed: false
  });

  harness.renderers.renderJobMonitor();

  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /approval/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Focus this browser job/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Visible page owner: this job follows the active readable tab/);
  assert.match(harness.dom.window.document.querySelector("#jobs-list").textContent, /Background approval: Focus activates tab 77 before approve or deny/);
  assert.match(harness.dom.window.document.querySelector(".job-approval-card").textContent, /Approval needed: Submit public form/);
  assert.match(harness.dom.window.document.querySelector(".job-approval-card").textContent, /Checkout Review/);
  assert.match(harness.dom.window.document.querySelector(".job-approval-card").textContent, /https:\/\/shop\.example\/review/);
  assert.match(harness.dom.window.document.querySelector(".job-approval-card").textContent, /shop\.example · tab 77/);
  assert.match(harness.dom.window.document.querySelector(".job-approval-card").textContent, /Review the visible page state before approving/);
  [...harness.dom.window.document.querySelectorAll(".job-actions button")]
    .find((button) => button.textContent === "Focus")
    .click();
  assert.deepEqual(harness.state.focused, ["job-approval"]);
  [...harness.dom.window.document.querySelectorAll(".job-actions button")]
    .find((button) => button.textContent === "Approve once")
    .click();
  assert.deepEqual(harness.state.approved, ["job-approval"]);
  [...harness.dom.window.document.querySelectorAll(".job-actions button")]
    .find((button) => button.textContent === "Deny")
    .click();
  assert.deepEqual(harness.state.denied, ["job-approval"]);
});

test("monitor renderers show and hide site permission panel", async () => {
  const harness = createHarness({ permission: "read-only" });

  await harness.renderers.renderSitePermissionPanel();

  assert.equal(harness.dom.window.document.querySelector("#site").hidden, false);
  assert.equal(harness.dom.window.document.querySelector("#host").textContent, "example.com");
  assert.equal(harness.dom.window.document.querySelector("#mode").value, "read-only");
  assert.match(harness.dom.window.document.querySelector("#note").textContent, /Can see\/do now: page text/);
  assert.match(harness.dom.window.document.querySelector("#note").textContent, /Cannot click/);

  harness.state.contextDockExpanded = false;
  await harness.renderers.renderSitePermissionPanel();

  assert.equal(harness.dom.window.document.querySelector("#site").hidden, true);
});

test("monitor renderers show and revoke task consent history", async () => {
  const harness = createHarness({
    taskConsents: {
      "example.com::booking": {
        siteKey: "example.com",
        taskClass: "booking",
        mode: "allow-safe",
        grantedAt: 1000,
        expiresAt: 2000,
        reason: "Trusted after approval",
        source: "approval-card"
      },
      "other.com::research": {
        siteKey: "other.com",
        taskClass: "research",
        mode: "allow-safe",
        grantedAt: 1000,
        expiresAt: 2000
      },
      "example.com::research": {
        siteKey: "example.com",
        taskClass: "research",
        mode: "allow-once",
        grantedAt: 1500,
        expiresAt: 3000,
        reason: "Allowed once from preflight",
        source: "control-preflight",
        sessionOnly: true,
        usesRemaining: 1
      }
    }
  });

  await harness.renderers.renderTaskConsentPanel();

  assert.equal(harness.dom.window.document.querySelector("#consents").hidden, false);
  assert.match(harness.dom.window.document.querySelector("#consents-title").textContent, /2 trusted task classes/);
  assert.match(harness.dom.window.document.querySelector("#consents-list").textContent, /booking/);
  assert.match(harness.dom.window.document.querySelector("#consents-list").textContent, /Trusted after approval/);
  assert.match(harness.dom.window.document.querySelector("#consents-list").textContent, /allow-once/);
  assert.match(harness.dom.window.document.querySelector("#consents-list").textContent, /this execution only/);
  assert.doesNotMatch(harness.dom.window.document.querySelector("#consents-list").textContent, /other\.com/);
  [...harness.dom.window.document.querySelectorAll("#consents-list button")]
    .find((button) => /booking/.test(button.title))
    .click();
  assert.deepEqual(harness.state.revoked, ["booking"]);

  harness.state.contextDockExpanded = false;
  await harness.renderers.renderTaskConsentPanel();
  assert.equal(harness.dom.window.document.querySelector("#consents").hidden, true);
});

test("monitor renderers show permission manager across sites and grants", async () => {
  const harness = createHarness({
    sitePermissions: {
      "blocked.example": "blocked",
      "default.example": "ask-before-action",
      "read.example": "read-only"
    },
    sitePermissionAudit: {
      "blocked.example": [{ action: "set", at: 1000, source: "slash-command", reason: "blocked for test" }]
    },
    taskConsents: {
      "example.com::booking": {
        siteKey: "example.com",
        taskClass: "booking",
        mode: "allow-safe",
        grantedAt: 1000,
        expiresAt: 2000,
        reason: "trusted for booking",
        source: "approval-card"
      }
    },
    taskConsentAudit: {
      "example.com::booking": [{ action: "set", at: 1000, source: "approval-card", reason: "trusted for booking" }],
      "old.example::research": [{ action: "revoke", at: 1100, source: "settings", reason: "release test revoke" }]
    }
  });

  await harness.renderers.renderPermissionManager();

  const panel = harness.dom.window.document.querySelector("#permission-manager");
  const list = harness.dom.window.document.querySelector("#permission-manager-list");
  assert.equal(panel.hidden, false);
  assert.match(harness.dom.window.document.querySelector("#permission-manager-title").textContent, /4 browser grant\/history entries/);
  assert.match(list.textContent, /blocked.example/);
  assert.match(list.textContent, /blocked for test/);
  assert.match(list.textContent, /read.example/);
  assert.doesNotMatch(list.textContent, /default.example/);
  assert.match(list.textContent, /example.com · booking/);
  assert.match(list.textContent, /trusted for booking/);
  assert.match(list.textContent, /old.example · research/);
  assert.match(list.textContent, /release test revoke/);
  list.querySelector("button").click();
  assert.deepEqual(harness.state.resetSites, ["blocked.example"]);
  list.querySelectorAll("button")[2].click();
  assert.deepEqual(harness.state.revoked, ["booking"]);

  harness.state.contextDockExpanded = false;
  await harness.renderers.renderPermissionManager();
  assert.equal(panel.hidden, true);
});
