import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskConsentStore,
  taskClassForGoal,
  taskConsentKey
} from "../resonantos-side-panel-extension/src/lib/task-consent-store.js";

function createHarness(overrides = {}) {
  const state = overrides.state ?? {};
  const storage = {
    get: async (key) => ({ [key]: state[key] ?? {} }),
    set: async (patch) => Object.assign(state, patch)
  };
  return {
    state,
    store: createTaskConsentStore({
      storage,
      taskConsentStorageKey: "augmentorTaskConsents",
      now: overrides.now ?? (() => 1000),
      ttlMs: overrides.ttlMs ?? 5000
    })
  };
}

test("task consent store classifies task goals conservatively", () => {
  assert.equal(taskClassForGoal("find a booking slot"), "booking");
  assert.equal(taskClassForGoal("go to amazon and compare headphones"), "shopping");
  assert.equal(taskClassForGoal("find AI news"), "research");
  assert.equal(taskClassForGoal("fill this form"), "form-edit");
  assert.equal(taskClassForGoal("go to resonantos.com"), "navigation");
  assert.equal(taskClassForGoal("do something"), "general");
});

test("task consent store persists scoped safe-action consent", async () => {
  const harness = createHarness();
  const consent = await harness.store.setTaskConsent({
    siteKey: "example.com",
    goal: "find a booking slot",
    source: "test"
  });

  assert.equal(consent.siteKey, "example.com");
  assert.equal(consent.taskClass, "booking");
  assert.equal(consent.mode, "allow-safe");
  assert.equal(consent.expiresAt, 6000);
  assert.equal(consent.reason, "Trusted safe task class");
  assert.deepEqual(await harness.store.consentFor({ siteKey: "example.com", goal: "find a booking slot" }), consent);
  assert.equal(await harness.store.consentFor({ siteKey: "example.com", goal: "shop for shoes" }), null);
  const audit = await harness.store.taskConsentAudit();
  assert.equal(audit["example.com::booking"][0].action, "set");
  assert.equal(audit["example.com::booking"][0].reason, "Trusted safe task class");
});

test("task consent store expires and revokes consent by site and task class", async () => {
  let clock = 1000;
  const harness = createHarness({ now: () => clock, ttlMs: 5000 });

  await harness.store.setTaskConsent({ siteKey: "example.com", goal: "research AI news" });
  assert.ok(await harness.store.consentFor({ siteKey: "example.com", goal: "research AI news" }));

  clock = 7001;
  assert.equal(await harness.store.consentFor({ siteKey: "example.com", goal: "research AI news" }), null);

  clock = 8000;
  await harness.store.setTaskConsent({ siteKey: "example.com", goal: "research AI news" });
  assert.equal(await harness.store.revokeTaskConsent({ siteKey: "example.com", goal: "research AI news", reason: "test revoke" }), true);
  assert.equal(await harness.store.consentFor({ siteKey: "example.com", goal: "research AI news" }), null);
  assert.equal((await harness.store.taskConsentAudit())["example.com::research"][0].action, "revoke");
  assert.equal((await harness.store.taskConsentAudit())["example.com::research"][0].reason, "test revoke");
});

test("task consent store keeps allow-once consent session-only and consumes it", async () => {
  const harness = createHarness();
  const consent = await harness.store.setTaskConsent({
    siteKey: "example.com",
    goal: "find current AI news",
    mode: "allow-once",
    reason: "one run only",
    source: "test"
  });

  assert.equal(consent.mode, "allow-once");
  assert.equal(consent.sessionOnly, true);
  assert.equal(consent.usesRemaining, 1);
  assert.equal(harness.state.augmentorTaskConsents, undefined);
  assert.equal((await harness.store.consentFor({ siteKey: "example.com", goal: "find current AI news" })).mode, "allow-once");

  const consumed = await harness.store.consumeTaskConsent({
    siteKey: "example.com",
    goal: "find current AI news",
    reason: "used by test"
  });

  assert.equal(consumed.usesRemaining, 0);
  assert.equal(await harness.store.consentFor({ siteKey: "example.com", goal: "find current AI news" }), null);
  const audit = await harness.store.taskConsentAudit();
  assert.deepEqual(audit["example.com::research"].map((entry) => entry.action), ["consume-once", "set-once"]);
});

test("task consent keys are explicit and portable", () => {
  assert.equal(taskConsentKey({ siteKey: "example.com", taskClass: "booking" }), "example.com::booking");
});
