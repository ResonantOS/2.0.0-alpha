import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppCommandHandlers,
  parseDraftAddonCommand,
  parseCommandSections,
  parseHistorySearchCommand,
  parseNaturalDelegationIntent,
  sitePermissionModeFromText
} from "../resonantos-side-panel-extension/src/lib/app-command-handlers.js";

function createHarness(overrides = {}) {
  const calls = [];
  const jobs = overrides.jobs ?? [{ id: "job-a", goal: "Find slot", status: "running" }];
  const browserJobStore = {
    activateJob: async (id) => calls.push(["activate", id]),
    findJob: (query = "") => query ? jobs.find((job) => job.id.includes(query) || job.goal.toLowerCase().includes(String(query).toLowerCase())) ?? null : jobs[0] ?? null,
    getActiveJobId: () => overrides.activeJobId ?? "job-a",
    getJobs: () => jobs,
    getSchedulerState: () => overrides.schedulerState ?? {
      activeSlots: jobs.filter((job) => ["running", "approval"].includes(job.status)).length,
      capacityBlockedQueued: [],
      lockBlockedQueued: [],
      maxConcurrent: 2,
      runnableQueued: jobs.filter((job) => job.status === "queued")
    }
  };
  const bridgeResponses = {
    "/goals": { id: "goal-a", mission: "Build" },
    "/addons/delegate": (body) => ({
      id: `${body?.target ?? "opencode"}-delegation-a`,
      target: body?.target ?? "opencode",
      path: `/tmp/${body?.target ?? "opencode"}-task.md`
    }),
    "/hermes/delegation/start": {
      id: "hermes-delegation-a",
      resultArtifactPath: "BrowserFirst/DelegationArtifacts/hermes/hermes-delegation-a-result.md",
      status: "completed"
    },
    "/hermes/status": {
      available: true,
      command: "~/bin/hermes",
      dashboard: { running: false, url: "http://127.0.0.1:9119" },
      executionEnabled: false,
      mode: "local-hermes-cli-disabled",
      taskCounts: { queued: 1 },
      boundary: "Hermes is host-mediated."
    },
    "/opencode/delegation/start": {
      id: "opencode-delegation-a",
      resultArtifactPath: "BrowserFirst/DelegationArtifacts/opencode/opencode-delegation-a-result.md",
      status: "completed"
    },
    "/addons/draft": { id: "email-draft-a", target: "email", path: "AddOnDrafts/email/email-draft-a.md", status: "draft-created", approvalRequired: true },
    "/status": {
      providers: { "shared-minimax": true, "shared-zai-glm": false, "shared-openai": false },
      memory: { wiki: { pages: 3 }, intake: { artifacts: 2 }, review: { requests: 1, artifacts: 1 } },
      addons: [{ name: "OpenCode", available: true, mode: "addon" }],
      records: { goals: 1, delegations: 2 }
    },
    "/memory/search": { query: "resonant", matches: [{ title: "ResonantOS", path: "wiki/resonantos.md", excerpt: "OS" }] },
    "/archive/intake": { path: "INTAKE/browser/history-search.md", bytes: 320 },
    "/archive/review/request": { path: "REVIEW/requests/history-search.md", status: "pending" },
    ...overrides.bridgeResponses
  };
  const handlers = createAppCommandHandlers({
    activeTab: async () => ({ url: "https://example.com/page" }),
    addMessage: async (role, content) => calls.push(["message", role, content]),
    bridgeRequest: async (path, options = {}) => {
      calls.push(["bridge", path, options.body ?? null]);
      const response = bridgeResponses[path];
      return typeof response === "function" ? response(options.body ?? {}) : response;
    },
    browserJobStore,
    chrome: {
      history: {
        search: async () => [
          { title: "Example", url: "https://example.com/" },
          { title: "Other", url: "https://other.example/" }
        ]
      },
      tabs: {
        query: async () => [
          { title: "Example tab", url: "https://example.com/page" },
          { title: "Private tab", url: "https://example.com/private", incognito: true },
          { title: "Other tab", url: "https://other.example/page" },
          { title: "Extension tab", url: "chrome-extension://abc/panel.html" }
        ]
      }
    },
    detectWalletState: async (options = {}) => {
      calls.push(["wallet", options]);
      if (options.announce) {
        calls.push(["message", "system", "Wallet status\nPhantom Solana: available, not connected\n\nBoundary: read-only detection."]);
      }
      return { ok: true, state: { detected: true } };
    },
    finishControlRun: (status) => calls.push(["finish", status]),
    focusBrowserJob: overrides.focusBrowserJob ?? null,
    getCurrentControlRun: () => overrides.currentControlRun ?? { status: "running" },
    permissionForUrl: async () => "ask-before-action",
    renderJobMonitor: () => calls.push(["renderJobs"]),
    renderSitePermissionPanel: async () => calls.push(["renderSite"]),
    restartBrowserJob: async (job) => calls.push(["restart", job.id, job.goal, job.steps?.length ?? 0]),
    saveBrowserJobReportToArchive: async (job) => {
      calls.push(["saveReport", job.id]);
      return { path: "INTAKE/browser/job-report.md" };
    },
    setActivity: (...args) => calls.push(["activity", ...args]),
    setSitePermission: async (_url, mode, audit) => ({ audit, key: "example.com", mode }),
    setStatus: (status) => calls.push(["status", status]),
    siteKeyForUrl: () => "example.com",
    tickBrowserJobScheduler: overrides.tickBrowserJobScheduler,
    updateBrowserJob: async (id, patch) => {
      const job = jobs.find((item) => item.id === id);
      if (job) Object.assign(job, patch);
      calls.push(["updateJob", id, patch]);
      return job ?? null;
    }
  });
  return { calls, handlers };
}

test("app command handlers parse sections and site permission modes", () => {
  assert.deepEqual(parseCommandSections("Build | success: tests, build | constraints: safe"), [
    "Build",
    "success: tests, build",
    "constraints: safe"
  ]);
  assert.equal(sitePermissionModeFromText("block this site"), "blocked");
  assert.equal(sitePermissionModeFromText("read only"), "read-only");
  assert.equal(sitePermissionModeFromText("trusted"), "trusted-for-safe-actions");
  assert.equal(sitePermissionModeFromText("normal"), "ask-before-action");
});

test("app command handlers parse draft-only email and calendar commands", () => {
  assert.deepEqual(parseDraftAddonCommand("email", "Follow up with Alex | subject: Project update | body: The browser work is ready."), {
    target: "email",
    intent: "Project update",
    body: "The browser work is ready."
  });
  assert.deepEqual(parseDraftAddonCommand("calendar", "Book planning call | title: Planning | details: Tuesday 10:00 with the team"), {
    target: "calendar",
    intent: "Planning",
    body: "Tuesday 10:00 with the team"
  });
  assert.equal(parseDraftAddonCommand("wallet", "no"), null);
});

test("app command handlers parse natural delegation intents", () => {
  assert.deepEqual(parseNaturalDelegationIntent("ask Hermes to research the best provider route"), {
    missingTarget: false,
    mission: "research the best provider route",
    target: "hermes"
  });
  assert.deepEqual(parseNaturalDelegationIntent("delegate this to OpenCode: inspect the failing tests"), {
    missingTarget: false,
    mission: "inspect the failing tests",
    target: "opencode"
  });
  assert.deepEqual(parseNaturalDelegationIntent("please route this work to the Resonant Engineer to diagnose provider recovery"), {
    missingTarget: false,
    mission: "diagnose provider recovery",
    target: "engineer"
  });
  assert.deepEqual(parseNaturalDelegationIntent("spawn Hermes to review the research packet"), {
    missingTarget: false,
    mission: "review the research packet",
    target: "hermes"
  });
  assert.deepEqual(parseNaturalDelegationIntent("dispatch this task to OpenCode: tighten the command router"), {
    missingTarget: false,
    mission: "tighten the command router",
    target: "opencode"
  });
  assert.deepEqual(parseNaturalDelegationIntent("can you delegate this to another agent?"), {
    missingTarget: true,
    mission: "to another agent?",
    target: ""
  });
  assert.deepEqual(parseNaturalDelegationIntent("can you spawn or delegate to other agents?"), {
    missingTarget: true,
    mission: "or delegate to other agents?",
    target: ""
  });
  assert.deepEqual(parseNaturalDelegationIntent("can you use the ResonantOS agent control layer directly?"), {
    missingTarget: true,
    mission: "can you use the ResonantOS agent control layer directly?",
    target: ""
  });
  assert.equal(parseNaturalDelegationIntent("hello augmentor"), null);
  assert.equal(parseNaturalDelegationIntent("explain the strategy without delegating"), null);
});

test("app command handlers create governed natural delegations", async () => {
  const harness = createHarness({
    bridgeResponses: {
      "/addons/delegate": { id: "hermes-a", target: "hermes", path: "/tmp/hermes-task.md" },
      "/hermes/delegation/start": {
        artifact: {
          finalSummary: "Hermes identified the settings architecture risk and wrote a reviewable result."
        },
        id: "hermes-a",
        resultArtifactPath: "BrowserFirst/DelegationArtifacts/hermes/hermes-a-result.md",
        status: "completed"
      }
    }
  });

  await harness.handlers.runNaturalDelegationCommand({
    missingTarget: false,
    mission: "research the next ResonantOS settings architecture slice",
    target: "hermes"
  });

  assert.ok(harness.calls.some((call) =>
    call[0] === "bridge" &&
    call[1] === "/addons/delegate" &&
    call[2].target === "hermes" &&
    /settings architecture/.test(call[2].mission)
  ));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Delegation queued for Hermes/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /governed task packet/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/hermes/delegation/start"));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Hermes execution completed/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Result: Hermes identified the settings architecture risk/.test(call[2])));
});

test("app command handlers ask for target when natural delegation is underspecified", async () => {
  const harness = createHarness();

  await harness.handlers.runNaturalDelegationCommand({ missingTarget: true, mission: "fix this", target: "" });

  assert.ok(harness.calls.some((call) => call[0] === "message" && /Choose a target/.test(call[2])));
  assert.equal(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/addons/delegate"), false);
});

test("app command handlers parse history filters", () => {
  assert.deepEqual(parseHistorySearchCommand("resonant dao | site:www.resonantos.com/path | days:7 | limit:12 | tabs:yes"), {
    days: 7,
    includeTabs: true,
    saveToIntake: false,
    maxResults: 12,
    query: "resonant dao",
    site: "resonantos.com"
  });
  assert.equal(parseHistorySearchCommand("recent tabs").includeTabs, true);
  assert.equal(parseHistorySearchCommand("recent tabs").query, "");
  assert.equal(parseHistorySearchCommand("resonant | intake").saveToIntake, true);
  assert.equal(parseHistorySearchCommand("resonant | export:no").saveToIntake, false);
});

test("app command handlers create goals and delegations", async () => {
  const harness = createHarness();

  await harness.handlers.runGoalCommand("Build | success: tests, build | constraints: safe");
  await harness.handlers.runDelegateCommand("opencode fix browser tests");
  await harness.handlers.runDelegateCommand("hermes coordinate the research handoff");

  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/goals" && call[2].mission === "Build"));
  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/addons/delegate" && call[2].target === "opencode"));
  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/addons/delegate" && call[2].target === "hermes"));
  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/opencode/delegation/start"));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Goal workspace recorded/.test(call[2])));
});

test("app command handlers reject vague delegation before creating packets", async () => {
  const harness = createHarness();

  await harness.handlers.runDelegateCommand("hermes");
  await harness.handlers.runDelegateCommand("opencode fix");

  assert.equal(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/addons/delegate"), false);
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Give Hermes a concrete mission/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Give OpenCode a concrete mission/.test(call[2])));
});

test("app command handlers report Hermes runtime status", async () => {
  const harness = createHarness();

  await harness.handlers.runHermesStatusCommand();

  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/hermes/status"));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Hermes runtime status/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Execution: disabled/.test(call[2])));
});

test("app command handlers report recent delegated work", async () => {
  const harness = createHarness({
    bridgeResponses: {
      "/addons/delegate/list": {
        delegations: [{
          mission: "review provider routing",
          path: "BrowserFirst/Delegations/hermes/hermes-a.md",
          resultArtifactPath: "BrowserFirst/DelegationArtifacts/hermes/hermes-a-result.md",
          resultExcerpt: "Hermes reviewed the routing packet.",
          status: "completed",
          target: "hermes",
          updatedAt: "2026-05-31T10:00:00.000Z"
        }]
      }
    }
  });

  await harness.handlers.runDelegationsCommand("hermes");

  assert.ok(harness.calls.some((call) => call[0] === "bridge" && call[1] === "/addons/delegate/list" && call[2].target === "hermes"));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Recent delegated work/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Hermes reviewed the routing packet/.test(call[2])));
});

test("app command handlers create draft-only communication packets", async () => {
  const harness = createHarness({
    bridgeResponses: {
      "/addons/draft": { id: "calendar-draft-a", target: "calendar", path: "AddOnDrafts/calendar/calendar-draft-a.md", status: "draft-created", approvalRequired: true }
    }
  });

  await harness.handlers.runDraftAddonCommand("calendar", "Planning call | body: Hold Tuesday 10:00 for ResonantOS review.");

  assert.ok(harness.calls.some((call) =>
    call[0] === "bridge" &&
    call[1] === "/addons/draft" &&
    call[2].target === "calendar" &&
    call[2].intent === "Planning call"
  ));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Scheduling calendar events is not automated from chat/.test(call[2])));

  await harness.handlers.runDraftAddonCommand("email", "");
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Sending remains human-approval gated/.test(call[2])));
});

test("app command handlers report status, memory, history, capabilities, and site permissions", async () => {
  const harness = createHarness();

  await harness.handlers.runStatusCommand();
  await harness.handlers.runMemorySearchCommand("resonant");
  await harness.handlers.runHistorySearchCommand("example");
  await harness.handlers.runCapabilitiesCommand();
  await harness.handlers.runWalletStatusCommand();
  await harness.handlers.runSitePermissionCommand("trusted");

  assert.ok(harness.calls.some((call) => call[0] === "message" && /ResonantOS Browser status/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Living Archive matches/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Browser history matches/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /What Augmentor can do now/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "wallet" && call[1].announce === true));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Wallet status/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Assistant permission to trusted-for-safe-actions/.test(call[2])));
});

test("app command handlers synthesize filtered history and recent readable tabs", async () => {
  const harness = createHarness();

  await harness.handlers.runHistorySearchCommand("example | site:example.com | days:7 | tabs");

  const message = harness.calls.find((call) => call[0] === "message" && /Recent readable tabs/.test(call[2]))?.[2] ?? "";
  assert.match(message, /Example tab/);
  assert.match(message, /Browser history matches for "example"/);
  assert.match(message, /Filter: site example.com/);
  assert.match(message, /Window: 7 day/);
  assert.match(message, /Incognito activity is excluded/);
  assert.doesNotMatch(message, /Private tab/);
  assert.doesNotMatch(message, /Other tab/);
});

test("app command handlers save browser activity searches to archive intake", async () => {
  const harness = createHarness();

  await harness.handlers.runHistorySearchCommand("example | site:example.com | days:7 | tabs | intake");

  const intakeCall = harness.calls.find((call) => call[0] === "bridge" && call[1] === "/archive/intake");
  const reviewCall = harness.calls.find((call) => call[0] === "bridge" && call[1] === "/archive/review/request");
  const savedMessage = harness.calls.find((call) => call[0] === "message" && /Saved browser activity search/.test(call[2]))?.[2] ?? "";

  assert.equal(intakeCall[2].origin, "browser-history-search");
  assert.equal(intakeCall[2].metadata.incognitoExcluded, true);
  assert.equal(intakeCall[2].metadata.historyMatches, 1);
  assert.equal(intakeCall[2].metadata.readableTabs, 1);
  assert.match(intakeCall[2].content, /# Browser Activity Search/);
  assert.match(intakeCall[2].content, /Incognito activity: excluded/);
  assert.match(intakeCall[2].content, /Example tab/);
  assert.doesNotMatch(intakeCall[2].content, /Private tab/);
  assert.equal(reviewCall[2].path, "INTAKE/browser/history-search.md");
  assert.match(savedMessage, /Review request created: REVIEW\/requests\/history-search\.md/);
});

test("app command handlers manage browser jobs", async () => {
  const focused = [];
  const harness = createHarness({
    focusBrowserJob: async (id) => focused.push(id),
    jobs: [
      { id: "job-a", goal: "Find slot", status: "running", updatedAt: "2026-05-26T09:00:00.000Z", steps: [{ type: "read", label: "Read page", state: "completed", updatedAt: "2026-05-26T09:00:00.000Z" }] },
      { id: "job-b", goal: "Research DAO", status: "paused", steps: [{ type: "read", label: "Read DAO", state: "completed" }] }
    ]
  });

  await harness.handlers.runJobsCommand();
  await harness.handlers.runJobsCommand("focus job-b");
  await harness.handlers.pauseBrowserJob("job-a");
  await harness.handlers.resumeBrowserJob("job-a");
  await harness.handlers.reportBrowserJob("job-a");
  await harness.handlers.cancelBrowserJob("job-a");

  assert.ok(harness.calls.some((call) => call[0] === "message" && /Browser jobs/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Scheduler:/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /attention job-a: Running job has no recent recorded progress/.test(call[2])));
  assert.deepEqual(focused, ["job-b", "job-a"]);
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Focused browser job job-b/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "finish" && call[1] === "paused"));
  assert.ok(harness.calls.some((call) => call[0] === "updateJob" && call[2].status === "paused"));
  assert.equal(harness.calls.some((call) => call[0] === "activate" && call[1] === "job-a"), false);
  assert.ok(harness.calls.some((call) => call[0] === "restart" && call[1] === "job-a" && call[3] === 1));
  assert.ok(harness.calls.some((call) => call[0] === "saveReport" && call[1] === "job-a"));
  assert.ok(harness.calls.some((call) => call[0] === "message" && /Saved browser job report/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "updateJob" && call[2].status === "cancelled"));
});

test("app command handlers resume and continue through the job focus boundary", async () => {
  const calls = [];
  const harness = createHarness({
    focusBrowserJob: async (id) => calls.push(["focus", id]),
    jobs: [
      { id: "job-paused", goal: "Resume focused tab", status: "paused", steps: [{ type: "read", state: "completed" }] },
      { id: "job-done", goal: "Continue focused tab", status: "completed", steps: [{ type: "read", state: "completed" }] }
    ]
  });

  await harness.handlers.resumeBrowserJob("job-paused");
  await harness.handlers.continueBrowserJob("job-done");

  assert.deepEqual(calls, [
    ["focus", "job-paused"],
    ["focus", "job-done"]
  ]);
  assert.deepEqual(
    harness.calls.filter((call) => call[0] === "restart").map((call) => call[1]),
    ["job-paused", "job-done"]
  );
  assert.equal(harness.calls.some((call) => call[0] === "activate" && ["job-paused", "job-done"].includes(call[1])), false);
});

test("app command handlers do not restart jobs when focus boundary fails", async () => {
  const harness = createHarness({
    focusBrowserJob: async (id) => {
      throw new Error(`locked tab missing for ${id}`);
    },
    jobs: [
      { id: "job-paused", goal: "Resume missing tab", status: "paused", steps: [{ type: "read", state: "completed" }] },
      { id: "job-done", goal: "Continue missing tab", status: "completed", steps: [{ type: "read", state: "completed" }] }
    ]
  });

  await harness.handlers.runJobsCommand("focus job-paused");
  await harness.handlers.resumeBrowserJob("job-paused");
  await harness.handlers.continueBrowserJob("job-done");

  assert.equal(harness.calls.some((call) => call[0] === "restart"), false);
  assert.equal(harness.calls.some((call) => call[0] === "updateJob" && call[2].status === "queued"), false);
  const failureMessages = harness.calls
    .filter((call) => call[0] === "message")
    .map((call) => call[2])
    .join("\n");
  assert.match(failureMessages, /Cannot focus browser job job-paused/);
  assert.match(failureMessages, /locked tab missing for job-paused/);
  assert.match(failureMessages, /Cannot focus browser job job-done/);
  assert.match(failureMessages, /I will not resume or approve this job until its controlled tab can be recovered/);
});

test("app command handlers can start runnable queued browser jobs through the scheduler", async () => {
  const harness = createHarness({
    tickBrowserJobScheduler: async () => ({
      schedulerState: {
        activeSlots: 1,
        capacityBlockedQueued: [],
        lockBlockedQueued: [],
        maxConcurrent: 2,
        runnableQueued: []
      },
      startedJobs: [{ id: "job-queued", goal: "Read docs" }]
    })
  });

  await harness.handlers.runJobsCommand("run");

  assert.ok(harness.calls.some((call) =>
    call[0] === "message" &&
    /Started 1 browser job: job-queued/.test(call[2]) &&
    /Scheduler: 1\/2 active/.test(call[2])
  ));
});

test("app command handlers continue a previous browser job through restart boundary", async () => {
  const harness = createHarness({
    jobs: [{
      id: "job-b",
      goal: "Find product",
      status: "completed",
      steps: [{ type: "read", label: "Read page", state: "completed" }]
    }]
  });

  await harness.handlers.continueBrowserJob("job-b");

  assert.ok(harness.calls.some((call) => call[0] === "message" && /Continuing browser job job-b/.test(call[2])));
  assert.ok(harness.calls.some((call) => call[0] === "restart" && call[1] === "job-b" && call[2] === "Find product" && call[3] === 1));
});
