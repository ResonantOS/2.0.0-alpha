import assert from "node:assert/strict";
import test from "node:test";

import { createSidePanelControlPreflightController } from "../resonantos-side-panel-extension/src/lib/side-panel-control-preflight-controller.js";

function createStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get(key) {
      if (Array.isArray(key)) {
        return Object.fromEntries(key.map((item) => [item, state[item]]));
      }
      return { [key]: state[key] };
    },
    async remove(key) {
      delete state[key];
    },
    async set(patch) {
      Object.assign(state, patch);
    }
  };
}

function createHarness({ initialPreflight = null } = {}) {
  const events = [];
  const storage = createStorage({
    augmentorControlPreflight: initialPreflight
  });
  let pendingControlPreflight = null;
  let nextDecision = null;
  const controller = createSidePanelControlPreflightController({
    addMessage: async (role, content) => {
      events.push(["message", role, content]);
    },
    controlPreflightStorageKey: "augmentorControlPreflight",
    getPendingControlPreflight: () => pendingControlPreflight,
    renderControlPreflightCard: () => events.push(["render-preflight"]),
    renderPermissionManager: async () => events.push(["render-permissions"]),
    renderSitePermissionPanel: async (tab) => events.push(["render-site", tab?.url ?? ""]),
    renderTaskConsentPanel: async () => events.push(["render-consent"]),
    runControlCommand: async (goal, options) => events.push(["run-control", goal, options]),
    setActivity: (...args) => events.push(["activity", ...args]),
    setContextDockExpanded: async (expanded) => events.push(["dock", expanded]),
    setNextControlPreflightDecision: (decision) => {
      nextDecision = decision;
      events.push(["decision", decision.mode]);
    },
    setPendingControlPreflight: (preflight) => {
      pendingControlPreflight = preflight;
    },
    setStatus: (status) => events.push(["status", status]),
    storage,
    taskConsentStore: {
      async consumeTaskConsent(consent) {
        events.push(["consume-consent", consent]);
        return consent;
      },
      async setTaskConsent(consent) {
        events.push(["consent", consent]);
        return {
          siteKey: consent.siteKey,
          taskClass: consent.taskClass
        };
      }
    }
  });
  return {
    controller,
    events,
    getNextDecision: () => nextDecision,
    getPending: () => pendingControlPreflight,
    storage
  };
}

test("side panel control preflight controller hydrates and persists durable preflight state", async () => {
  const harness = createHarness({
    initialPreflight: {
      id: "control-existing",
      goal: "find a book and compare prices",
      mode: "ask-before-action",
      siteKey: "example.com",
      taskClass: "shopping",
      createdAt: "2026-06-01T00:00:00.000Z"
    }
  });

  await harness.controller.hydrateControlPreflight();

  assert.equal(harness.getPending().id, "control-existing");
  assert.deepEqual(harness.events, [["render-preflight"]]);

  await harness.controller.clearControlPreflight();
  assert.equal(harness.getPending(), null);
  assert.equal("augmentorControlPreflight" in harness.storage.state, false);
});

test("side panel control preflight controller requests approval without starting browser control", async () => {
  const harness = createHarness();

  await harness.controller.requestControlPreflight({
    goal: "go to amazon.it and find a good pair of jeans under 50 euro",
    mode: "ask-before-action",
    siteKey: "amazon.it",
    tab: { url: "https://amazon.it/" }
  });

  assert.equal(harness.getPending().siteKey, "amazon.it");
  assert.equal(harness.storage.state.augmentorControlPreflight.siteKey, "amazon.it");
  assert.ok(harness.events.some((event) => event[0] === "dock" && event[1] === true));
  assert.ok(harness.events.some((event) => event[0] === "message" && /Agent Control preflight required/.test(event[2])));
  assert.equal(harness.events.some((event) => event[0] === "run-control"), false);
});

test("side panel control preflight controller approves and trusts through explicit decisions", async () => {
  const harness = createHarness();
  await harness.controller.requestControlPreflight({
    goal: "research current AI browser news and compare sources",
    mode: "ask-before-action",
    siteKey: "news.example"
  });

  const preflightId = harness.getPending().id;
  await harness.controller.trustControlPreflightForSafeActions(preflightId);

  assert.equal(harness.getPending(), null);
  assert.equal(harness.getNextDecision().mode, "trusted-safe-actions");
  assert.ok(harness.events.some((event) => event[0] === "consent" && event[1].mode === "allow-safe"));
  assert.ok(harness.events.some((event) => event[0] === "run-control" && event[2].preflightApproved === true));
});

test("side panel control preflight controller allows a task class once without durable trust", async () => {
  const harness = createHarness();
  await harness.controller.requestControlPreflight({
    goal: "research current AI browser news and compare sources",
    mode: "ask-before-action",
    siteKey: "news.example"
  });

  await harness.controller.allowControlPreflightOnceForTaskClass(harness.getPending().id);

  assert.equal(harness.getPending(), null);
  assert.equal(harness.getNextDecision().mode, "allowed-task-class-once");
  assert.ok(harness.events.some((event) => event[0] === "consent" && event[1].mode === "allow-once"));
  assert.ok(harness.events.some((event) => event[0] === "consume-consent"));
  assert.ok(harness.events.some((event) => event[0] === "message" && /for this execution only/.test(event[2])));
  assert.ok(harness.events.some((event) => event[0] === "run-control" && event[2].preflightApproved === true));
});

test("side panel control preflight controller denies without invoking browser control", async () => {
  const harness = createHarness();
  await harness.controller.requestControlPreflight({
    goal: "book the next available appointment",
    mode: "ask-before-action",
    siteKey: "booking.example"
  });

  await harness.controller.denyControlPreflight(harness.getPending().id);

  assert.equal(harness.getPending(), null);
  assert.ok(harness.events.some((event) => event[0] === "status" && event[1] === "Denied"));
  assert.equal(harness.events.some((event) => event[0] === "run-control"), false);
});
