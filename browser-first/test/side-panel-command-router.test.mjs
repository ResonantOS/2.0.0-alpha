import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelCommandRouter } from "../resonantos-side-panel-extension/src/lib/side-panel-command-router.js";

function createHarness({ resumableControlRun = false } = {}) {
  const calls = [];
  const handler = (name) => async (...args) => {
    calls.push([name, ...args]);
  };
  const router = createSidePanelCommandRouter({
    hasResumableControlRun: () => resumableControlRun,
    allowControlPreflightOnceForTaskClass: handler("allow-control-once"),
    bindMentionedTab: handler("bind"),
    cancelBrowserJob: handler("cancel"),
    approveControlPreflight: handler("approve-control"),
    continueBrowserJob: handler("continue"),
    clickActivePageText: handler("click"),
    denyControlPreflight: handler("deny-control"),
    detectActivePageForms: handler("forms"),
    explainStructuredPageEditBoundary: handler("structured"),
    handleWalletBoundary: handler("wallet"),
    openBrowserUrl: handler("open"),
    pauseBrowserJob: handler("pause"),
    prepareDaoWorkflowGuidance: handler("dao"),
    resumeBrowserJob: handler("resume"),
    runBrowserCommand: handler("browser"),
    runCapabilitiesCommand: handler("capabilities"),
    runChatTurn: handler("chat"),
    runControlCommand: handler("control"),
    runDelegateCommand: handler("delegate"),
    runDelegationsCommand: handler("delegations"),
    runDraftAddonCommand: handler("draft"),
    runGoalCommand: handler("goal"),
    runHermesStatusCommand: handler("hermes-status"),
    runHistorySearchCommand: handler("history"),
    runJobsCommand: handler("jobs"),
    runMemorySearchCommand: handler("memory"),
    runNaturalDelegationCommand: handler("natural-delegate"),
    runResonatorCommand: handler("resonator"),
    reportBrowserJob: handler("report"),
    runSitePermissionCommand: handler("site"),
    runStatusCommand: handler("status"),
    runWalletStatusCommand: handler("wallet-status"),
    saveWalletDaoAuditToArchive: handler("wallet-audit"),
    saveIntake: handler("save"),
    scrollActivePage: handler("scroll"),
    searchBrowser: handler("search"),
    summarizeActivePage: handler("summarize-page"),
    summarizeSnapshot: handler("summary"),
    typeIntoActivePage: handler("type")
  });
  return { calls, router };
}

test("side panel command router dispatches slash commands", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("/goal build the app");
  await harness.router.respondToCommand("/hermes");
  await harness.router.respondToCommand("/hermes status");
  await harness.router.respondToCommand("/hermes coordinate research handoff");
  await harness.router.respondToCommand("/delegate opencode fix tests");
  await harness.router.respondToCommand("/delegations hermes");
  await harness.router.respondToCommand("/status");
  await harness.router.respondToCommand("/browser open resonantos.com");
  await harness.router.respondToCommand("/control find a booking");
  await harness.router.respondToCommand("/highlight #target");
  await harness.router.respondToCommand("/email Follow up | body: Draft the email");
  await harness.router.respondToCommand("/calendar Planning | body: Draft the event");
  await harness.router.respondToCommand("/save selection");
  await harness.router.respondToCommand("/trail dao research");

  assert.deepEqual(harness.calls, [
    ["bind", "/goal build the app"],
    ["goal", "build the app"],
    ["bind", "/hermes"],
    ["hermes-status"],
    ["bind", "/hermes status"],
    ["hermes-status"],
    ["bind", "/hermes coordinate research handoff"],
    ["delegate", "hermes coordinate research handoff"],
    ["bind", "/delegate opencode fix tests"],
    ["delegate", "opencode fix tests"],
    ["bind", "/delegations hermes"],
    ["delegations", "hermes"],
    ["bind", "/status"],
    ["status"],
    ["bind", "/browser open resonantos.com"],
    ["browser", "open resonantos.com"],
    ["bind", "/control find a booking"],
    ["control", "find a booking"],
    ["bind", "/highlight #target"],
    ["resonator", "highlight", "#target"],
    ["bind", "/email Follow up | body: Draft the email"],
    ["draft", "email", "Follow up | body: Draft the email"],
    ["bind", "/calendar Planning | body: Draft the event"],
    ["draft", "calendar", "Planning | body: Draft the event"],
    ["bind", "/save selection"],
    ["save", "selection"],
    ["bind", "/trail dao research"],
    ["save", "trail dao research"]
  ]);
});

test("side panel command router dispatches browser state slash commands", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("/site read-only");
  await harness.router.respondToCommand("/memory augmentatism");
  await harness.router.respondToCommand("/history resonantos");
  await harness.router.respondToCommand("/wallet status");
  await harness.router.respondToCommand("/wallet audit");
  await harness.router.respondToCommand("/dao review proposal");
  await harness.router.respondToCommand("/dao audit review proposal");
  await harness.router.respondToCommand("/capabilities");
  await harness.router.respondToCommand("/jobs running");
  await harness.router.respondToCommand("/pause job-a");
  await harness.router.respondToCommand("/resume job-a");
  await harness.router.respondToCommand("/continue job-a");
  await harness.router.respondToCommand("/report job-a");
  await harness.router.respondToCommand("/cancel job-a");
  await harness.router.respondToCommand("/approve-control control-a");
  await harness.router.respondToCommand("/allow-control-once control-a");
  await harness.router.respondToCommand("/deny-control control-a");

  assert.deepEqual(harness.calls.map((call) => call[0]), [
    "bind", "site",
    "bind", "memory",
    "bind", "history",
    "bind", "wallet-status",
    "bind", "wallet-audit",
    "bind", "dao",
    "bind", "wallet-audit",
    "bind", "capabilities",
    "bind", "jobs",
    "bind", "pause",
    "bind", "resume",
    "bind", "continue",
    "bind", "report",
    "bind", "cancel",
    "bind", "approve-control",
    "bind", "allow-control-once",
    "bind", "deny-control"
  ]);
});

test("side panel command router dispatches Resonator guide slash commands", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("/highlight #hero");
  await harness.router.respondToCommand('/arrow ".primary" Continue here');
  await harness.router.respondToCommand("/spotlight #checkout Review this");
  await harness.router.respondToCommand("/step #one First; #two Second");
  await harness.router.respondToCommand("/clear");

  assert.deepEqual(harness.calls.filter((call) => call[0] !== "bind"), [
    ["resonator", "highlight", "#hero"],
    ["resonator", "arrow", "\".primary\" Continue here"],
    ["resonator", "spotlight", "#checkout Review this"],
    ["resonator", "step", "#one First; #two Second"],
    ["resonator", "clear", ""]
  ]);
});

test("side panel command router dispatches natural browser intents before chat", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("take control: find the booking page");
  await harness.router.respondToCommand('type "resonantos" into the search bar');
  await harness.router.respondToCommand('click "Add to cart"');
  await harness.router.respondToCommand("can you read this page?");
  await harness.router.respondToCommand("can you check the loaded page?");
  await harness.router.respondToCommand("what can you see here?");
  await harness.router.respondToCommand("scroll to the bottom");
  await harness.router.respondToCommand("show form fields");
  await harness.router.respondToCommand("go to resonantos.com/dao");
  await harness.router.respondToCommand("can you navigate to manoloremiddi.com?");
  await harness.router.respondToCommand("find latest AI news on the internet");
  await harness.router.respondToCommand("hey what's the most inportant new in the world today?");
  await harness.router.respondToCommand("go to amazon.it and find me a rtx5090");
  await harness.router.respondToCommand("add the visible item on this page to the cart");

  assert.deepEqual(harness.calls.filter((call) => call[0] !== "bind").map((call) => call[0]), [
    "control",
    "type",
    "click",
    "summary",
    "summary",
    "summary",
    "scroll",
    "forms",
    "open",
    "open",
    "search",
    "search",
    "control",
    "control"
  ]);
  const dispatched = harness.calls.filter((call) => call[0] !== "bind");
  assert.deepEqual(dispatched.at(-2), ["control", "go to amazon.it and find me a rtx5090"]);
  assert.deepEqual(dispatched.at(-1), ["control", "add the visible item on this page to the cart"]);
});

test("side panel command router reads + summarizes the page for a bare summarize/tldr/recap", async () => {
  const harness = createHarness();

  // Bare summarize-family commands route to a silent page read + chat summary
  // (handler "summarize-page"), before the generic read intent's title+excerpt.
  await harness.router.respondToCommand("summarize");
  await harness.router.respondToCommand("tldr");
  await harness.router.respondToCommand("recap this page");
  // A plain conversational message still goes to chat, untouched by the branch.
  await harness.router.respondToCommand("what should I cook tonight?");

  const dispatched = harness.calls.filter((call) => call[0] !== "bind").map((call) => call[0]);
  assert.deepEqual(dispatched, ["summarize-page", "summarize-page", "summarize-page", "chat"]);
});

test("side panel command router continues a resumable run on a bare 'try again', else chats", async () => {
  const resumable = createHarness({ resumableControlRun: true });
  await resumable.router.respondToCommand("try again");
  await resumable.router.respondToCommand("continue");
  assert.deepEqual(
    resumable.calls.filter((call) => call[0] !== "bind").map((call) => call[0]),
    ["continue", "continue"]
  );

  // With no resumable run, a bare "try again" is just a chat turn.
  const noRun = createHarness({ resumableControlRun: false });
  await noRun.router.respondToCommand("try again");
  assert.deepEqual(
    noRun.calls.filter((call) => call[0] !== "bind").map((call) => call[0]),
    ["chat"]
  );
});

test("side panel command router sends compound navigate-and-act commands to agent control", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("go to fifa.com and click on news");
  await harness.router.respondToCommand("open espn.com and search for scores");

  const dispatched = harness.calls.filter((call) => call[0] !== "bind");
  assert.deepEqual(dispatched, [
    ["control", "go to fifa.com and click on news"],
    ["control", "open espn.com and search for scores"]
  ]);
});

test("side panel command router dispatches natural delegation before chat", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("ask Hermes to research the project options");
  await harness.router.respondToCommand("delegate this to OpenCode: inspect the failing tests");
  await harness.router.respondToCommand("spawn Hermes to review the research packet");
  await harness.router.respondToCommand("can you pass this to another agent?");
  await harness.router.respondToCommand("can you spawn or delegate to other agents?");

  assert.deepEqual(harness.calls.filter((call) => call[0] !== "bind"), [
    ["natural-delegate", { missingTarget: false, mission: "research the project options", target: "hermes" }],
    ["natural-delegate", { missingTarget: false, mission: "inspect the failing tests", target: "opencode" }],
    ["natural-delegate", { missingTarget: false, mission: "review the research packet", target: "hermes" }],
    ["natural-delegate", { missingTarget: true, mission: "to another agent?", target: "" }],
    ["natural-delegate", { missingTarget: true, mission: "or delegate to other agents?", target: "" }]
  ]);
});

test("side panel command router falls back to slash delegation if natural handler is missing", async () => {
  const calls = [];
  const router = createSidePanelCommandRouter({
    bindMentionedTab: async (...args) => calls.push(["bind", ...args]),
    runChatTurn: async (...args) => calls.push(["chat", ...args]),
    runDelegateCommand: async (...args) => calls.push(["delegate", ...args])
  });

  await router.respondToCommand("ask Hermes to research the project options");

  assert.deepEqual(calls, [
    ["bind", "ask Hermes to research the project options"],
    ["delegate", "hermes research the project options"]
  ]);
});

test("side panel command router gates wallet terms and falls back to chat", async () => {
  const harness = createHarness();

  await harness.router.respondToCommand("help me with Phantom wallet");
  await harness.router.respondToCommand("hello");

  assert.deepEqual(harness.calls.filter((call) => call[0] !== "bind").map((call) => call[0]), ["wallet", "chat"]);
});
