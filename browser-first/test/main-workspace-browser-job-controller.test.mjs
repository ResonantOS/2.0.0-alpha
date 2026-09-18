import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBrowserJob } from "../resonantos-side-panel-extension/src/lib/browser-job-store.js";
import { createMainWorkspaceBrowserJobController } from "../resonantos-side-panel-extension/src/lib/main-workspace-browser-job-controller.js";

const storageKeys = {
  activeBrowserJob: "activeBrowserJob",
  browserJobs: "browserJobs",
  pendingSidebarPrompt: "pendingSidebarPrompt"
};

function createMemoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(keys) {
      if (!Array.isArray(keys)) return { ...data };
      return Object.fromEntries(keys.map((key) => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    }
  };
}

test("main workspace browser job controller opens the full monitor through sidebar prompt", async () => {
  const storage = createMemoryStorage();
  const events = [];
  const controller = createMainWorkspaceBrowserJobController({
    now: () => "2026-05-31T10:00:00.000Z",
    openSidebar: async () => events.push("sidebar"),
    storage,
    storageKeys
  });

  await controller.openMonitor();

  assert.deepEqual(storage.data.pendingSidebarPrompt, {
    createdAt: "2026-05-31T10:00:00.000Z",
    prompt: "/jobs"
  });
  assert.deepEqual(events, ["sidebar"]);
});

test("main workspace browser job controller focuses a durable browser job", async () => {
  const storage = createMemoryStorage({ browserJobs: [{ id: "job-123", status: "running" }] });
  const events = [];
  const controller = createMainWorkspaceBrowserJobController({
    afterChange: () => events.push("render"),
    now: () => "2026-05-31T10:01:00.000Z",
    openSidebar: async () => events.push("sidebar"),
    storage,
    storageKeys
  });

  const result = await controller.focusJob({ id: "job-123", goal: "Find a booking slot" });

  assert.equal(result, true);
  assert.equal(storage.data.activeBrowserJob, "job-123");
  assert.deepEqual(storage.data.pendingSidebarPrompt, {
    createdAt: "2026-05-31T10:01:00.000Z",
    prompt: "/jobs focus job-123"
  });
  assert.deepEqual(events, ["render", "sidebar"]);
});

test("main workspace browser job controller routes pause and continue through side-panel authority", async () => {
  const storage = createMemoryStorage({ browserJobs: [{ id: "job-123", status: "running" }] });
  const events = [];
  const controller = createMainWorkspaceBrowserJobController({
    afterChange: () => events.push("render"),
    now: (() => {
      const times = [
        "2026-05-31T10:01:00.000Z",
        "2026-05-31T10:02:00.000Z"
      ];
      return () => times.shift() ?? "2026-05-31T10:03:00.000Z";
    })(),
    openSidebar: async () => events.push("sidebar"),
    storage,
    storageKeys
  });

  assert.equal(await controller.pauseJob({ id: "job-123", goal: "Find a booking slot" }), true);
  assert.equal(storage.data.activeBrowserJob, "job-123");
  assert.deepEqual(storage.data.pendingSidebarPrompt, {
    createdAt: "2026-05-31T10:01:00.000Z",
    prompt: "/pause job-123"
  });

  assert.equal(await controller.continueJob({ id: "job-123", goal: "Find a booking slot" }), true);
  assert.equal(storage.data.activeBrowserJob, "job-123");
  assert.deepEqual(storage.data.pendingSidebarPrompt, {
    createdAt: "2026-05-31T10:02:00.000Z",
    prompt: "/continue job-123"
  });
  assert.deepEqual(events, ["render", "sidebar", "render", "sidebar"]);
});

test("main workspace browser job controller cancels non-terminal jobs and releases page locks", async () => {
  const storage = createMemoryStorage({
    activeBrowserJob: "job-a",
    browserJobs: [
      {
        id: "job-a",
        goal: "Search for news",
        pageLock: { siteKey: "news.example", tabId: 5 },
        status: "running"
      },
      {
        id: "job-b",
        goal: "Completed task",
        pageLock: null,
        status: "completed"
      }
    ]
  });
  const events = [];
  const controller = createMainWorkspaceBrowserJobController({
    addSystemMessage: async (message) => events.push(["system", message]),
    afterChange: () => events.push(["render"]),
    now: () => "2026-05-31T10:02:00.000Z",
    storage,
    storageKeys
  });

  const result = await controller.cancelJob({ id: "job-a", goal: "Search for news" });

  assert.equal(result, true);
  assert.equal(storage.data.activeBrowserJob, "job-a");
  assert.deepEqual(storage.data.browserJobs[0], normalizeBrowserJob({
    id: "job-a",
    goal: "Search for news",
    completedAt: "2026-05-31T10:02:00.000Z",
    pageLock: null,
    status: "cancelled",
    updatedAt: "2026-05-31T10:02:00.000Z"
  }));
  assert.deepEqual(events, [
    ["system", "Stopped browser job job-a: Search for news"],
    ["render"]
  ]);
});

test("main workspace browser job controller does not rewrite terminal jobs", async () => {
  const storage = createMemoryStorage({
    browserJobs: [{
      id: "job-a",
      goal: "Already blocked",
      pageLock: { siteKey: "wallet.example", tabId: 9 },
      status: "blocked"
    }]
  });
  const events = [];
  const controller = createMainWorkspaceBrowserJobController({
    addSystemMessage: async (message) => events.push(message),
    afterChange: () => events.push("render"),
    storage,
    storageKeys
  });

  const result = await controller.cancelJob({ id: "job-a", goal: "Already blocked" });

  assert.equal(result, false);
  assert.equal(storage.data.browserJobs[0].status, "blocked");
  assert.deepEqual(events, []);
});

const focusRefusal = "This saved browser job cannot be focused safely. Reopen the side panel to reload and repair browser job history.";
test("cancel uses fresh sanitized history and reports only committed success", async () => {
  const storage = createMemoryStorage({ browserJobs: [{ id: "target", status: "running", goal: "old" }] });
  const events = []; const messages = [];
  const controller = createMainWorkspaceBrowserJobController({ storage, storageKeys,
    afterChange: () => events.push("render"), openSidebar: async () => events.push("sidebar"),
    addSystemMessage: async (message) => messages.push(message) });
  const displayed = (await controller.readJobs()).jobs[0];
  storage.data.browserJobs = [{ id: "target", status: "running", goal: 'client_secret="private"' },
    { id: "sibling", status: "paused", summary: 'client_secret="private"' }];
  assert.equal(await controller.cancelJob(displayed), true);
  assert.equal(messages[0], 'Stopped browser job target: client_secret="REDACTED"');
  assert.equal(storage.data.browserJobs[1].summary, 'client_secret="REDACTED"');
  assert.equal(storage.data.activeBrowserJob, "target"); assert.deepEqual(events, ["render"]);
  assert.equal(await controller.cancelJob(displayed), false, "fresh terminal target is a quiet no-op");
  assert.equal(messages.length, 1);
  for (const failure of ["get", "set"]) {
    const broken = createMemoryStorage({ browserJobs: [{ id: "target", status: "running" }] });
    broken[failure] = async () => { throw new Error("private failure"); };
    const effects = []; const notices = [];
    const failing = createMainWorkspaceBrowserJobController({ storage: broken, storageKeys,
      afterChange: () => effects.push("render"), openSidebar: async () => effects.push("sidebar"),
      addSystemMessage: async (message) => notices.push(message) });
    for (const action of ["cancelJob", "focusJob", "pauseJob", "continueJob"]) {
      assert.equal(await failing[action]({ id: "target" }), false);
    }
    assert.deepEqual(effects, []); assert.equal(notices.length, 4);
    for (const notice of notices) {
      assert.match(notice, /could not/i); assert.doesNotMatch(notice, /private|Stopped browser job/);
    }
  }
});

test("focus pause and continue validate stored identity without rewriting history", async () => {
  for (const action of ["focusJob", "pauseJob", "continueJob"]) {
    for (const id of [undefined, null, "", 42, "safe", "absent", "duplicate", "token=private", "two words", "line\nbreak", "control\u0000char"]) {
      const jobs = ["safe", "duplicate", "duplicate", "token=private", "two words", "line\nbreak", "control\u0000char"]
        .map((id) => ({ id, status: "running", goal: "original" }));
      const storage = createMemoryStorage({ browserJobs: jobs }); const writes = []; const messages = [];
      const save = storage.set; storage.set = async (value) => { writes.push(value); await save(value); };
      const controller = createMainWorkspaceBrowserJobController({ storage, storageKeys,
        addSystemMessage: async (message) => messages.push(message) });
      assert.equal(await controller[action]({ id }), id === "safe", `${action}: ${id}`);
      assert.equal(writes.length, id === "safe" ? 1 : 0);
      assert.deepEqual(storage.data.browserJobs, jobs);
      if (id === "safe") {
        assert.deepEqual(Object.keys(writes[0]).sort(), ["activeBrowserJob", "pendingSidebarPrompt"]);
        const command = { focusJob: "jobs focus", pauseJob: "pause", continueJob: "continue" }[action];
        assert.equal(writes[0].pendingSidebarPrompt.prompt, `/${command} safe`);
      } else assert.deepEqual(messages, [focusRefusal]);
    }
  }
});

test("history reads expose failure retain last good data and recover without writes", { timeout: 2000 }, async (t) => {
  let value = {};
  let failure = true;
  let pending;
  let reads = 0;
  let writes = 0;
  const storage = {
    get() { reads++; if (failure) throw new Error("private read error"); return pending?.promise ?? Promise.resolve(value); },
    async set() { writes++; }
  };
  const controller = createMainWorkspaceBrowserJobController({ storage, storageKeys });
  assert.deepEqual(await controller.readJobs(), { jobs: [], activeJobId: "", historyState: "error" });
  failure = false;
  value = { browserJobs: [{ id: "saved", status: "paused", steps: [{ label: "original" }] }], activeBrowserJob: "saved" };
  const ready = await controller.readJobs();
  assert.equal(ready.historyState, "ready");
  ready.jobs[0].steps[0].label = "caller mutation";
  value.browserJobs[0].steps[0].label = "storage mutation";
  for (const malformed of [null, [], { browserJobs: null }, { browserJobs: {} }, { browserJobs: [null] }, { browserJobs: [[]] }, { activeBrowserJob: {} }]) {
    value = malformed;
    const failed = await controller.readJobs();
    assert.equal(failed.historyState, "error");
    assert.equal(failed.activeJobId, "saved");
    assert.equal(failed.jobs[0].steps[0].label, "original");
    failed.jobs.length = 0;
  }
  pending = Promise.withResolvers();
  t.after(() => pending?.resolve({}));
  const before = reads;
  const first = controller.readJobs();
  const second = controller.readJobs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, before + 1, "pending reads coalesce");
  pending.resolve({});
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { jobs: [], activeJobId: "", historyState: "ready" });
  a.jobs.push({ id: "caller" });
  assert.deepEqual(b.jobs, [], "each reader gets a detached snapshot");
  pending = null;
  value = {};
  assert.equal((await controller.readJobs()).historyState, "ready");
  assert.equal(reads, before + 2, "settled reads permit another refresh");
  assert.equal(writes, 0);
});
