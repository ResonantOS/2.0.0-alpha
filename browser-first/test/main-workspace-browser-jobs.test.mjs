import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  mainBrowserJobSnapshot,
  renderMainBrowserJobStatus
} from "../resonantos-side-panel-extension/src/lib/main-workspace-browser-jobs.js";

test("main workspace browser jobs summarize focused and queued Agent Control work", () => {
  const snapshot = mainBrowserJobSnapshot({
    activeJobId: "job-a",
    jobs: [
      {
        id: "job-a",
        goal: "Find booking slot",
        status: "running",
        pageLock: { tabId: 7, siteKey: "booking.example", url: "https://booking.example/" },
        steps: [
          { label: "Read page", state: "completed", type: "read" },
          { label: "Click slot", state: "active", type: "click" }
        ]
      },
      {
        id: "job-b",
        goal: "Research docs",
        status: "queued",
        pageLock: { tabId: 8, siteKey: "docs.example", url: "https://docs.example/" }
      }
    ],
    maxConcurrent: 2
  });

  assert.equal(snapshot.activeCount, 2);
  assert.deepEqual(snapshot.approvalJobs, []);
  assert.equal(snapshot.focusedJob.id, "job-a");
  assert.deepEqual(snapshot.scheduler.runnableQueued.map((job) => job.id), ["job-b"]);
});

test("main workspace browser jobs prioritize approval jobs when no active focus exists", () => {
  const snapshot = mainBrowserJobSnapshot({
    jobs: [
      {
        id: "job-running",
        goal: "Read background docs",
        status: "running",
        pageLock: { tabId: 4, siteKey: "docs.example", url: "https://docs.example/" }
      },
      {
        id: "job-approval",
        goal: "Review booking submit",
        status: "approval",
        pendingApproval: {
          reason: "Public submit requires human review.",
          step: { type: "click", text: "Book slot" }
        },
        pageLock: { tabId: 9, siteKey: "booking.example", url: "https://booking.example/" }
      }
    ],
    maxConcurrent: 2
  });

  assert.equal(snapshot.activeCount, 2);
  assert.deepEqual(snapshot.approvalJobs.map((job) => job.id), ["job-approval"]);
  assert.equal(snapshot.focusedJob.id, "job-approval");
});

test("main workspace browser jobs do not focus a completed active id while work remains active", () => {
  const snapshot = mainBrowserJobSnapshot({
    activeJobId: "job-done",
    jobs: [
      {
        id: "job-done",
        goal: "Finished task",
        status: "completed",
        pageLock: null
      },
      {
        id: "job-running",
        goal: "Still running",
        status: "running",
        pageLock: { tabId: 9, siteKey: "active.example", url: "https://active.example/" }
      }
    ],
    maxConcurrent: 2
  });

  assert.equal(snapshot.focusedJob.id, "job-running");
  assert.equal(snapshot.activeCount, 1);
});

test("main workspace browser jobs render monitor, focus, and stop controls", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const events = [];
  const container = dom.window.document.querySelector("#jobs");

  const snapshot = renderMainBrowserJobStatus({
    activeJobId: "job-a",
    container,
    jobs: [{
      id: "job-a",
      goal: "Find booking slot",
      status: "approval",
      pageLock: { tabId: 7, siteKey: "booking.example", url: "https://booking.example/" },
      steps: [
        { label: "Read page", state: "completed", type: "read" },
        {
          label: "Submit form",
          state: "blocked",
          type: "click",
          details: {
            actionRetry: "precise-ref-retry",
            verificationRetry: "settle-reread"
          }
        }
      ]
    }],
    onCancelFocused: (job) => events.push(["cancel", job.id]),
    onFocusJob: (job) => events.push(["focus", job.id]),
    onOpenMonitor: () => events.push(["monitor"]),
    onPauseFocused: (job) => events.push(["pause", job.id])
  });

  assert.equal(snapshot.focusedJob.id, "job-a");
  assert.equal(container.hidden, false);
  assert.equal(container.dataset.status, "approval");
  assert.match(container.textContent, /Needs approval · Find booking slot/);
  assert.match(container.textContent, /1 active/);
  assert.match(container.textContent, /booking\.example · tab 7/);
  assert.match(container.textContent, /Awaiting approval/);
  assert.match(container.textContent, /Now: needs review · Submit form/);
  assert.equal(container.querySelector(".main-browser-jobs-current")?.textContent, "Now: needs review · Submit form");
  assert.match(container.textContent, /Recovery: rechecked: settle-reread · retried: precise-ref-retry/);

  [...container.querySelectorAll("button")].find((button) => button.textContent === "Focus").click();
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Open monitor").click();
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Pause").click();
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Stop").click();

  assert.deepEqual(events, [
    ["focus", "job-a"],
    ["monitor"],
    ["pause", "job-a"],
    ["cancel", "job-a"]
  ]);
});

test("main workspace browser jobs surface the active current action", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const container = dom.window.document.querySelector("#jobs");

  renderMainBrowserJobStatus({
    activeJobId: "job-running",
    container,
    jobs: [{
      id: "job-running",
      goal: "Compare prices",
      status: "running",
      steps: [
        { label: "Read page", state: "completed", type: "read" },
        { label: "Click visible filter", state: "active", type: "click" },
        { label: "Read filtered products", state: "pending", type: "read" }
      ]
    }],
    onOpenMonitor: () => undefined
  });

  assert.match(container.textContent, /Running · Compare prices/);
  assert.match(container.textContent, /Now: working · Click visible filter/);
  assert.equal(container.querySelector(".main-browser-jobs-current")?.textContent, "Now: working · Click visible filter");
});

test("main workspace browser jobs render continue for stopped or paused work", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const events = [];
  const container = dom.window.document.querySelector("#jobs");

  const snapshot = renderMainBrowserJobStatus({
    activeJobId: "job-paused",
    container,
    jobs: [{
      id: "job-paused",
      goal: "Continue product research",
      status: "paused",
      pageLock: null
    }],
    onContinueFocused: (job) => events.push(["continue", job.id]),
    onFocusJob: (job) => events.push(["focus", job.id]),
    onOpenMonitor: () => events.push(["monitor"])
  });

  assert.equal(snapshot.focusedJob.id, "job-paused");
  assert.match(container.textContent, /Paused · Continue product research/);
  assert.equal([...container.querySelectorAll("button")].some((button) => button.textContent === "Pause"), false);
  assert.equal([...container.querySelectorAll("button")].find((button) => button.textContent === "Open monitor").dataset.primary, undefined);
  assert.equal([...container.querySelectorAll("button")].find((button) => button.textContent === "Continue").dataset.primary, "true");

  [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue").click();

  assert.deepEqual(events, [["continue", "job-paused"]]);
});

test("main workspace browser jobs surface blocker guidance for stopped work", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const container = dom.window.document.querySelector("#jobs");

  const snapshot = renderMainBrowserJobStatus({
    activeJobId: "job-blocked",
    container,
    jobs: [{
      id: "job-blocked",
      goal: "Find exact booking slot",
      lastError: "calendar widget did not expose available times",
      status: "blocked",
      steps: [{
        label: "Click calendar date",
        state: "blocked",
        type: "click",
        details: {
          nextHumanAction: "Open the date picker manually, then continue the job.",
          recoveryOptions: [
            "Select a visible date before continuing",
            "Ask the site for keyboard navigation"
          ],
          uncertainty: "The page did not expose a clickable slot in the current snapshot."
        }
      }]
    }],
    onContinueFocused: () => undefined,
    onOpenMonitor: () => undefined
  });

  assert.equal(snapshot.focusedJob.id, "job-blocked");
  assert.equal(container.dataset.status, "blocked");
  assert.match(container.textContent, /Blocked · Find exact booking slot/);
  assert.match(container.textContent, /Next: Open the date picker manually, then continue the job/);
  assert.match(container.textContent, /Why stopped: The page did not expose a clickable slot/);
  assert.match(container.textContent, /Options: Select a visible date before continuing · Ask the site for keyboard navigation/);
  assert.match(container.textContent, /Last error: calendar widget did not expose available times/);
  assert.equal(container.querySelector(".main-browser-jobs-blocker")?.textContent.includes("Next:"), true);
});

test("main workspace browser jobs surface completed job outcome summaries", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const container = dom.window.document.querySelector("#jobs");

  const snapshot = renderMainBrowserJobStatus({
    activeJobId: "job-completed",
    container,
    jobs: [{
      id: "job-completed",
      goal: "Research current news",
      status: "completed",
      summary: "Opened news search and captured three current headlines.",
      steps: [{
        label: "Search news",
        note: "News page loaded.",
        state: "completed",
        type: "search"
      }]
    }],
    onOpenMonitor: () => undefined
  });

  assert.equal(snapshot.focusedJob.id, "job-completed");
  assert.equal(container.dataset.status, "completed");
  assert.match(container.textContent, /Completed · Research current news/);
  assert.match(container.textContent, /Result: Opened news search and captured three current headlines/);
  assert.equal(container.querySelector(".main-browser-jobs-outcome")?.textContent.startsWith("Result:"), true);
});

test("main workspace browser jobs render per-job approval review cards", () => {
  const dom = new JSDOM(`<section id="jobs"></section>`);
  const events = [];
  const container = dom.window.document.querySelector("#jobs");

  const snapshot = renderMainBrowserJobStatus({
    activeJobId: "job-running",
    container,
    jobs: [
      {
        id: "job-running",
        goal: "Compare products",
        status: "running",
        pageLock: { tabId: 3, siteKey: "shop.example", url: "https://shop.example/" }
      },
      {
        id: "job-approval",
        goal: "Reserve appointment",
        status: "approval",
        pageLock: { tabId: 11, siteKey: "booking.example", url: "https://booking.example/" },
        pendingApproval: {
          history: [{ observation: { title: "Booking checkout", url: "https://booking.example/confirm" } }],
          reason: "Clicking Book now is a public-submit boundary.",
          step: { type: "click", text: "Book now" }
        }
      }
    ],
    onCancelFocused: (job) => events.push(["cancel", job.id]),
    onFocusJob: (job) => events.push(["focus", job.id]),
    onOpenMonitor: () => events.push(["monitor"])
  });

  assert.equal(snapshot.focusedJob.id, "job-running");
  assert.deepEqual(snapshot.approvalJobs.map((job) => job.id), ["job-approval"]);
  assert.equal(container.dataset.status, "running");
  assert.match(container.textContent, /1 approval card/);
  assert.match(container.textContent, /Reserve appointment: Book now/);
  assert.match(container.textContent, /Clicking Book now is a public-submit boundary/);
  assert.match(container.textContent, /booking\.example · tab 11 · Booking checkout/);

  const reviewButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Focus review");
  reviewButton.click();

  assert.deepEqual(events, [["focus", "job-approval"]]);
});

test("workspace history failure exposes Retry and suppresses stale actions", { timeout: 2000 }, async (t) => {
  const { createMainWorkspaceBrowserJobController } = await import("../resonantos-side-panel-extension/src/lib/main-workspace-browser-job-controller.js");
  const dom = new JSDOM('<section id="jobs"></section>');
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("#jobs");
  let fail = true;
  let jobs = [];
  let pending;
  let reads = 0;
  let writes = 0;
  const controller = createMainWorkspaceBrowserJobController({ storage: {
    async get() { reads++; if (pending) await pending.promise; if (fail) throw Error("private"); return { augmentorBrowserJobs: jobs }; },
    async set() { writes++; }
  } });
  let snapshot;
  let inflight;
  const render = () => renderMainBrowserJobStatus({ ...snapshot, container, onRetryHistory: retry,
    onCancelFocused: () => assert.fail("stale Stop"), onFocusJob: () => assert.fail("stale Focus") });
  const refresh = async () => { snapshot = await controller.readJobs(); render(); };
  const retry = () => {
    if (inflight) return inflight;
    snapshot = { ...snapshot, historyState: "loading" }; render();
    inflight = refresh().finally(() => { inflight = null; });
    return inflight;
  };
  const assertError = () => {
    assert.equal(container.hidden, false, "failed empty history stays visible");
    assert.match(container.textContent, /Browser job history could not be loaded\./);
    assert.ok(container.querySelector('[data-status="blocked"]'));
    assert.deepEqual([...container.querySelectorAll("button")].map((b) => b.textContent), ["Retry"]);
  };
  await refresh(); assertError();
  container.querySelector("button").click(); await inflight; assertError();
  fail = false; jobs = [{ id: "saved", goal: "Saved task", status: "running" }];
  container.querySelector("button").click(); await inflight;
  assert.match(container.textContent, /Saved task/);
  fail = true; await refresh(); assertError();
  pending = Promise.withResolvers(); t.after(() => pending.resolve());
  const before = reads;
  const oldRetry = container.querySelector("button");
  oldRetry.click(); oldRetry.click();
  assert.equal(container.querySelector("button").disabled, true);
  assert.match(container.textContent, /Loading browser job history/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, before + 1);
  fail = false; jobs = []; pending.resolve(); await inflight;
  assert.equal(container.hidden, true, "successful empty history restores normal rendering");
  assert.equal(writes, 0, "workspace Retry reads only");
});

test("workspace composition shares checked Jobs and Control refresh and attention", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../resonantos-side-panel-extension/src/main-workspace.js", import.meta.url), "utf8");
  assert.match(source, /onRetryHistory: retryBrowserJobHistory/);
  assert.match(source, /retry\.addEventListener\("click", retryBrowserJobHistory\)/);
  assert.match(source, /snapshot\.historyState !== "ready" \|\|\s*hasBlockingBrowserJob\(snapshot\.jobs\)/);
  assert.match(source, /dockTabs\.signalActivity\("jobs", \{ blocking \}\)/);
  assert.match(source, /dockTabs\.signalActivity\("control", \{ blocking \}\)/);
  assert.doesNotMatch(source, /changes\[STORAGE_KEYS\.browserJobs\]\?\.newValue/);
  assert.equal((source.match(/mainBrowserJobController\.readJobs\(/g) ?? []).length, 1);
});

test("composed workspace refresh renders both surfaces from one read and coalesces both Retry buttons", { timeout: 2000 }, async (t) => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const { createMainWorkspaceBrowserJobController } = await import("../resonantos-side-panel-extension/src/lib/main-workspace-browser-job-controller.js");
  const { renderDockControl } = await import("../resonantos-side-panel-extension/src/lib/main-workspace-dock-panels.js");
  const { hasBlockingBrowserJob } = await import("../resonantos-side-panel-extension/src/lib/browser-job-store.js");
  const source = await readFile(new URL("../resonantos-side-panel-extension/src/main-workspace.js", import.meta.url), "utf8");
  const composition = source.slice(source.indexOf("let browserJobHistory ="), source.indexOf("const chatRenderers ="));
  const dom = new JSDOM('<section id="jobs"></section><section id="control"><strong></strong><span></span><div></div></section>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  let fail = false; let pending; let reads = 0; let writes = 0;
  let jobs = [{ id: "saved", status: "running", goal: "Saved task", steps: [{ label: "Stale step", state: "active" }] }];
  const controller = createMainWorkspaceBrowserJobController({ storage: {
    async get() { reads++; if (pending) await pending.promise; if (fail) throw Error("private"); return { augmentorBrowserJobs: jobs }; },
    async set() { writes++; }
  } });
  const signals = [];
  const mainBrowserJobs = document.querySelector("#jobs");
  const dockControlEls = { titleEl: document.querySelector("#control strong"), statusEl: document.querySelector("#control span"), stepListEl: document.querySelector("#control div") };
  const context = { document, mainBrowserJobs, dockControlEls, mainBrowserJobController: controller,
    renderMainBrowserJobStatus, renderDockControl, hasBlockingBrowserJob, activeWorkspace: "answer",
    dockTabs: { signalActivity: (name, options) => signals.push([name, options.blocking]) } };
  runInNewContext(composition, context);
  await context.renderMainBrowserJobStatusFromStorage();
  assert.match(dockControlEls.stepListEl.textContent, /Stale step/);
  fail = true;
  await context.renderMainBrowserJobStatusFromStorage();
  assert.match(mainBrowserJobs.textContent, /could not be loaded/);
  assert.match(dockControlEls.titleEl.textContent, /could not be loaded/);
  assert.doesNotMatch(dockControlEls.stepListEl.textContent, /Stale step/);
  assert.equal(dockControlEls.statusEl.dataset.status, "blocked");
  assert.deepEqual(signals.slice(-2), [["jobs", true], ["control", true]]);
  pending = Promise.withResolvers(); t.after(() => pending.resolve());
  const before = reads;
  const controlRetry = dockControlEls.stepListEl.querySelector("button");
  assert.equal(controlRetry.title, "Reload browser job history");
  assert.equal(controlRetry.title, mainBrowserJobs.querySelector("button").title);
  mainBrowserJobs.querySelector("button").click();
  controlRetry.click();
  const complete = context.renderMainBrowserJobStatusFromStorage();
  assert.equal(mainBrowserJobs.querySelector("button").disabled, true);
  assert.equal(dockControlEls.stepListEl.querySelector("button").disabled, true);
  assert.equal(dockControlEls.stepListEl.querySelector("button").title, "Reload browser job history");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, before + 1);
  fail = false; jobs = []; pending.resolve(); await complete;
  assert.equal(mainBrowserJobs.hidden, true);
  assert.equal(dockControlEls.statusEl.textContent, "idle");
  assert.equal(dockControlEls.statusEl.hasAttribute("data-status"), false);
  assert.equal(dockControlEls.stepListEl.children.length, 0);
  assert.deepEqual(signals.slice(-2), [["jobs", false], ["control", false]]);
  context.activeWorkspace = "settings"; fail = true;
  await context.renderMainBrowserJobStatusFromStorage();
  assert.equal(mainBrowserJobs.hidden, true, "workspace visibility boundary stays in place");
  assert.match(dockControlEls.titleEl.textContent, /could not be loaded/);
  assert.equal(writes, 0);
});
