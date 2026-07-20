import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resonantExtensionId = "cdpdmmalhmokbfcfgogoepnjplaakgnl";
const cdpTimeoutMs = Number.parseInt(process.env.RESONANTOS_LIVE_CDP_TIMEOUT_MS ?? "12000", 10);

async function freeLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch((error) => {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      console.log("browser-job-scheduler-live skipped: localhost bind is denied in this sandbox.");
      process.exit(0);
    }
    throw error;
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const fixturePort = await freeLoopbackPort();
const betaFixturePort = await freeLoopbackPort();
const debugPort = await freeLoopbackPort();
const bridgePort = await freeLoopbackPort();

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    let timeoutId = null;
    const response = new Promise((resolve, reject) => this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    }));
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${cdpTimeoutMs}ms.`));
      }, cdpTimeoutMs);
    });
    return Promise.race([response, timeout]);
  }

  close() {
    this.ws?.close();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForDebugPort(getHostLogs = () => "") {
  for (let index = 0; index < 60; index += 1) {
    try {
      return await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Browser debug port ${debugPort} did not become available. Host logs:\n${getHostLogs()}`);
}

async function browserTargets() {
  return fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
}

async function waitForBrowserTarget(predicate, label) {
  for (let index = 0; index < 80; index += 1) {
    const targets = await browserTargets();
    const target = targets.find(predicate);
    if (target?.webSocketDebuggerUrl) return target;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not appear in CDP targets.`);
}

async function openExtensionPanel() {
  await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`chrome-extension://${resonantExtensionId}/src/side-panel.html`)}`,
    { method: "PUT" },
  ).then((response) => response.json());
  return waitForBrowserTarget(
    (target) => target.url === `chrome-extension://${resonantExtensionId}/src/side-panel.html`,
    "ResonantOS side panel extension target"
  );
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "CDP evaluation failed.");
  }
  return result.result.value;
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html>
    <title>Alpha Browser Job Fixture</title>
    <h1>Alpha Browser Job Fixture</h1>
    <form id="alpha-form">
      <button id="alpha-submit" type="submit">Submit public form</button>
    </form>
    <script>
      window.__alphaSubmitted = false;
      document.querySelector("#alpha-form").addEventListener("submit", (event) => {
        event.preventDefault();
        window.__alphaSubmitted = true;
        document.body.dataset.alpha = "submitted";
      });
    </script>`);
});
const betaServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html>
    <title>Beta Browser Job Fixture</title>
    <h1>Beta Browser Job Fixture</h1>
    <button id="beta-finish">Beta Finish</button>
    <p id="beta-status">Beta idle</p>
    <script>
      document.querySelector("#beta-finish").addEventListener("click", () => {
        document.body.dataset.beta = "finished";
        document.querySelector("#beta-status").textContent = "Beta finished";
      });
    </script>`);
});

await new Promise((resolve) => server.listen(fixturePort, "127.0.0.1", resolve));
await new Promise((resolve) => betaServer.listen(betaFixturePort, "127.0.0.1", resolve));

const profile = path.join(os.tmpdir(), `resonantos-parallel-live-${Date.now()}`);
const host = spawn("node", [
  "browser-first/host/run-browser-first.mjs",
  `--url=http://127.0.0.1:${fixturePort}/`,
  `--profile=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  `--bridge-port=${bridgePort}`,
  "--auto-open-side-panel=false",
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let hostLogs = "";
host.stdout.on("data", (chunk) => { hostLogs += chunk.toString(); });
host.stderr.on("data", (chunk) => { hostLogs += chunk.toString(); });

async function shutdownHost() {
  host.stdout.destroy();
  host.stderr.destroy();
  if (!host.killed) host.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => host.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  spawnSync("pkill", ["-9", "-f", "run-browser-first.mjs"], { stdio: "ignore" });
}

async function waitForPanelReady(panel, label = "panel") {
  for (let index = 0; index < 80; index += 1) {
    const ready = await evaluate(panel, `Boolean(document.querySelector("#command-input") && chrome?.storage?.local)`).catch(() => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready.`);
}

async function waitForComposerEnabled(panel, label) {
  for (let index = 0; index < 120; index += 1) {
    const state = await evaluate(panel, `({
      disabled: document.querySelector("#command-input")?.disabled ?? true,
      text: document.body.innerText
    })`).catch((error) => ({ disabled: true, text: String(error?.message ?? error) }));
    if (!state.disabled) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const text = await evaluate(panel, `document.body.innerText`).catch(() => "");
  throw new Error(`${label} did not return composer control.\n${text}`);
}

async function submitPanelCommand(panel, command) {
  await waitForComposerEnabled(panel, `before ${command}`);
  await evaluate(panel, `(() => {
    const input = document.querySelector("#command-input");
    input.value = ${JSON.stringify(command)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#command-form").requestSubmit();
  })()`);
}

async function waitForStoredJob(panel, matcherExpression, label) {
  for (let index = 0; index < 160; index += 1) {
    const state = await evaluate(panel, `(async () => {
      const jobs = (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [];
      const job = jobs.find((entry) => (${matcherExpression})(entry));
      return { job, jobs, text: document.body.innerText };
    })()`);
    if (state.job) return state.job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const state = await evaluate(panel, `(async () => ({
    jobs: (await chrome.storage.local.get("augmentorBrowserJobs")).augmentorBrowserJobs ?? [],
    text: document.body.innerText
  }))()`);
  throw new Error(`${label} did not appear.\n${JSON.stringify(state.jobs, null, 2)}\n${state.text}`);
}

try {
  await waitForDebugPort(() => hostLogs);
  const panelTarget = await openExtensionPanel();
  const panel = new CdpClient(panelTarget.webSocketDebuggerUrl);
  await panel.connect();
  await panel.send("Runtime.enable");
  await panel.send("Page.enable");
  await waitForPanelReady(panel, "ResonantOS side panel");

  const result = await evaluate(panel, `(async () => {
    const [{ createBrowserJobScheduler }, { browserJobSchedulerState }] = await Promise.all([
      import(chrome.runtime.getURL("src/lib/browser-job-scheduler.js")),
      import(chrome.runtime.getURL("src/lib/browser-job-store.js"))
    ]);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let jobs = [
      { id: "job-a", goal: "Alpha", status: "queued", pageLock: { tabId: 101, siteKey: "alpha.test", url: "https://alpha.test/" } },
      { id: "job-b", goal: "Beta", status: "queued", pageLock: { tabId: 102, siteKey: "beta.test", url: "https://beta.test/" } },
      { id: "job-c", goal: "Alpha follow-up", status: "queued", pageLock: { tabId: 101, siteKey: "alpha.test", url: "https://alpha.test/next" } }
    ];
    const events = [];
    const store = {
      activateJob: async (id) => {
        events.push(["activate", id]);
      },
      findJob: (id) => jobs.find((job) => job.id === id) ?? null,
      getSchedulerState: (options) => browserJobSchedulerState(jobs, options),
      updateJob: async (id, patch) => {
        let updated = null;
        jobs = jobs.map((job) => {
          if (job.id !== id) return job;
          updated = { ...job, ...patch };
          if (["completed", "blocked", "denied", "cancelled", "failed", "paused"].includes(updated.status)) {
            updated.pageLock = null;
          }
          return updated;
        });
        events.push(["update", id, patch.status ?? "patch"]);
        return updated;
      }
    };
    const scheduler = createBrowserJobScheduler({
      browserJobStore: store,
      maxConcurrent: 2,
      onJobFinished: async (id) => events.push(["finished", id]),
      onJobStarted: async (job) => events.push(["started", job.id]),
      runJob: async (job) => {
        events.push(["run", job.id]);
        await wait(job.id === "job-a" ? 80 : 20);
        return { ok: true, id: job.id };
      }
    });
    scheduler.start();
    const firstTick = await scheduler.tick();
    const during = store.getSchedulerState({ maxConcurrent: 2 });
    await wait(180);
    const after = store.getSchedulerState({ maxConcurrent: 2 });
    return { after, during, events, firstTick, jobs };
  })()`);

  const started = result.events.filter((event) => event[0] === "started").map((event) => event[1]);
  const runs = result.events.filter((event) => event[0] === "run").map((event) => event[1]);
  assert(started.includes("job-a") && started.includes("job-b"), `Expected job-a and job-b to start together: ${JSON.stringify(result, null, 2)}`);
  assert(result.during.lockBlockedQueued.some((job) => job.id === "job-c" && job.blockerId === "job-a"), `Expected job-c to wait on job-a lock: ${JSON.stringify(result, null, 2)}`);
  assert(runs.includes("job-c"), `Expected job-c to auto-drain after job-a completed: ${JSON.stringify(result, null, 2)}`);
  assert(result.jobs.every((job) => job.status === "completed"), `Expected all jobs to complete: ${JSON.stringify(result, null, 2)}`);

  await evaluate(panel, `(async () => {
    await chrome.storage.local.set({
      augmentorActiveBrowserJob: "job-ui-running",
      augmentorBrowserJobs: [
      {
        id: "job-ui-running",
        goal: "Live UI running job",
        status: "running",
        createdAt: "2026-05-31T10:00:00.000Z",
        updatedAt: "2026-05-31T10:00:00.000Z",
        planner: "live-ui",
        pageLock: { tabId: 101, siteKey: "ui-running.test", url: "https://ui-running.test/", reason: "live UI test" },
        steps: [{ type: "read", label: "Read page", state: "active", updatedAt: "2026-05-31T10:00:00.000Z" }]
      },
      {
        id: "job-ui-queued",
        goal: "Live UI queued job",
        status: "queued",
        createdAt: "2026-05-31T09:59:00.000Z",
        updatedAt: "2026-05-31T09:59:00.000Z",
        planner: "live-ui",
        pageLock: { tabId: 102, siteKey: "ui-queued.test", url: "https://ui-queued.test/", reason: "live UI test" }
      }
    ],
      augmentorContextDockExpanded: true,
      augmentorJobMonitorCollapsed: false
    });
    location.reload();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const uiControlResult = await evaluate(panel, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 80; index += 1) {
      const monitor = document.querySelector("#job-monitor");
      const text = document.querySelector("#job-list")?.innerText ?? "";
      if (monitor && !monitor.hidden && /job-ui-running/.test(text) && /job-ui-queued/.test(text)) break;
      await wait(100);
    }
    const clickJobButton = (jobId, label) => {
      const item = [...document.querySelectorAll("#job-list > li")]
        .find((candidate) => candidate.querySelector("code")?.textContent === jobId);
      const button = [...(item?.querySelectorAll(".job-actions button") ?? [])]
        .find((candidate) => candidate.textContent === label);
      if (!button) throw new Error(\`Button \${label} missing for \${jobId}. Monitor: \${document.querySelector("#job-list")?.innerText ?? ""}\`);
      button.click();
    };
    clickJobButton("job-ui-queued", "Pause");
    await wait(150);
    clickJobButton("job-ui-running", "Cancel");
    await wait(150);
    const stored = await chrome.storage.local.get(["augmentorBrowserJobs", "augmentorActiveBrowserJob"]);
    return {
      activeJobId: stored.augmentorActiveBrowserJob,
      buttonsVisible: [...document.querySelectorAll(".job-actions button")].map((button) => button.textContent),
      jobMonitorVisible: !document.querySelector("#job-monitor")?.hidden,
      statuses: Object.fromEntries((stored.augmentorBrowserJobs ?? []).map((job) => [job.id, job.status]))
    };
  })()`);

  assert(uiControlResult.jobMonitorVisible, `Expected live job monitor to render: ${JSON.stringify(uiControlResult, null, 2)}`);
  assert(uiControlResult.statuses?.["job-ui-queued"] === "paused", `Pause button did not persist paused status: ${JSON.stringify(uiControlResult, null, 2)}`);
  assert(uiControlResult.statuses?.["job-ui-running"] === "cancelled", `Cancel button did not persist cancelled status: ${JSON.stringify(uiControlResult, null, 2)}`);
  await evaluate(panel, `chrome.storage.local.clear()`);
  const multiTabResult = await evaluate(panel, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const alphaTab = (await chrome.tabs.query({ url: ${JSON.stringify(`http://127.0.0.1:${fixturePort}/*`)} }))[0];
    const betaTab = await chrome.tabs.create({ url: ${JSON.stringify(`http://localhost:${betaFixturePort}/`)}, active: false });
    for (let index = 0; index < 80; index += 1) {
      const loaded = await chrome.tabs.get(betaTab.id);
      if (loaded.status === "complete" && /Beta Browser Job Fixture/.test(loaded.title || "")) break;
      await wait(100);
    }
    await chrome.storage.local.set({
      augmentorTaskConsents: {
        "127.0.0.1::research": {
          siteKey: "127.0.0.1",
          taskClass: "research",
          mode: "allow-safe",
          grantedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          reason: "Live multi-tab browser-job fixture consent.",
          source: "live-test"
        },
        "localhost::research": {
          siteKey: "localhost",
          taskClass: "research",
          mode: "allow-safe",
          grantedAt: Date.now(),
          expiresAt: Date.now() + 86400000,
          reason: "Live multi-tab browser-job fixture consent.",
          source: "live-test"
        }
      },
      augmentorContextDockExpanded: true,
      augmentorJobMonitorCollapsed: false
    });
    globalThis.__resonantosNextActionOverride = async ({ snapshot, history }) => {
      const title = String(snapshot?.title ?? "");
      if (/Alpha Browser Job Fixture/.test(title)) {
        return {
          source: "live-multitab-fixture",
          thought: "Alpha fixture intentionally requests a public-submit action so it remains pending while another tab can progress.",
          status: history.length ? "done" : "continue",
          action: history.length ? null : { type: "click", text: "Submit public form" },
          approvalReason: null,
          doneSummary: "Alpha fixture public-submit action is resolved."
        };
      }
      if (/Beta Browser Job Fixture/.test(title)) {
        return {
          source: "live-multitab-fixture",
          thought: history.length ? "Beta fixture is complete." : "Click the safe beta finish control.",
          status: history.length ? "done" : "continue",
          action: history.length ? null : { type: "click", text: "Beta Finish" },
          approvalReason: null,
          doneSummary: "Beta fixture completed while alpha was waiting."
        };
      }
      return {
        source: "live-multitab-fixture",
        thought: "Unexpected page for multi-tab fixture.",
        status: "blocked",
        action: null,
        approvalReason: "The active page was not one of the deterministic multi-tab fixtures."
      };
    };
    return { alphaTabId: alphaTab?.id ?? null, betaTabId: betaTab.id };
  })()`);
  assert(Number.isInteger(multiTabResult.alphaTabId), `Alpha fixture tab missing: ${JSON.stringify(multiTabResult)}`);
  assert(Number.isInteger(multiTabResult.betaTabId), `Beta fixture tab missing: ${JSON.stringify(multiTabResult)}`);

  await submitPanelCommand(panel, `/control research alpha fixture public submit @Alpha.`);
  const alphaApproval = await waitForStoredJob(
    panel,
    `(entry) => /research alpha fixture public submit/i.test(String(entry.goal ?? "")) && entry.status === "approval" && entry.pendingApproval`,
    "alpha approval browser job"
  );
  await submitPanelCommand(panel, `/control research beta fixture finish @Beta.`);
  const betaCompleted = await waitForStoredJob(
    panel,
    `(entry) => /research beta fixture finish/i.test(String(entry.goal ?? "")) && entry.status === "completed"`,
    "beta completed browser job"
  );
  const multiTabFinal = await evaluate(panel, `(async () => {
    const [alphaTab, betaTab, stored] = await Promise.all([
      chrome.tabs.get(${multiTabResult.alphaTabId}),
      chrome.tabs.get(${multiTabResult.betaTabId}),
      chrome.storage.local.get("augmentorBrowserJobs")
    ]);
    const betaResults = await chrome.scripting.executeScript({
      target: { tabId: ${multiTabResult.betaTabId} },
      func: () => ({ beta: document.body.dataset.beta || "", title: document.title })
    });
    const alphaResults = await chrome.scripting.executeScript({
      target: { tabId: ${multiTabResult.alphaTabId} },
      func: () => ({ alpha: document.body.dataset.alpha || "", title: document.title })
    });
    return {
      alpha: alphaResults?.[0]?.result,
      beta: betaResults?.[0]?.result,
      jobs: stored.augmentorBrowserJobs ?? [],
      tabs: [
        { id: alphaTab.id, url: alphaTab.url, title: alphaTab.title },
        { id: betaTab.id, url: betaTab.url, title: betaTab.title }
      ]
    };
  })()`);
  assert(multiTabFinal.alpha?.alpha !== "submitted", `Alpha public submit should remain blocked for approval: ${JSON.stringify(multiTabFinal, null, 2)}`);
  assert(multiTabFinal.beta?.beta === "finished", `Beta tab did not complete while alpha waited for approval: ${JSON.stringify(multiTabFinal, null, 2)}`);
  assert(alphaApproval.pageLock?.tabId !== betaCompleted.pageLock?.tabId, `Live jobs did not target separate tabs: ${JSON.stringify({ alphaApproval, betaCompleted }, null, 2)}`);
  console.log(JSON.stringify({
    ok: true,
    started,
    runs,
    finalStatuses: result.jobs.map((job) => [job.id, job.status]),
    multiTabResult,
    multiTabFinalStatuses: multiTabFinal.jobs
      .filter((job) => /research (alpha|beta) fixture/i.test(job.goal))
      .map((job) => [job.goal, job.status, job.pageLock?.siteKey ?? ""]),
    uiControlResult
  }, null, 2));
  panel.close();
} finally {
  await shutdownHost();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => betaServer.close(resolve));
}
