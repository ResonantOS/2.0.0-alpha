import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlPreflight,
  formatControlPreflightMessage,
  isLongAutonomousControlGoal,
  normalizeControlPreflight,
  shouldRequireControlPreflight
} from "../resonantos-side-panel-extension/src/lib/control-preflight.js";

test("control preflight classifies only substantial autonomous browser goals", () => {
  assert.equal(isLongAutonomousControlGoal("open resonantos.com"), false);
  assert.equal(isLongAutonomousControlGoal("find me a laptop on amazon that costs less than 900 euro"), true);
  assert.equal(isLongAutonomousControlGoal("book the next available appointment"), true);
  assert.equal(isLongAutonomousControlGoal("research current AI browser news and compare sources"), true);
});

test("control preflight respects explicit approval, resumed jobs, blocked sites, and safe consent", () => {
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro" }), true);
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro", alreadyApproved: true }), false);
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro", resumedFromJob: true }), false);
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro", mode: "blocked" }), false);
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro", existingConsent: { mode: "allow-safe" } }), false);
  assert.equal(shouldRequireControlPreflight({ goal: "find me a good pair of jeans under 50 euro", existingConsent: { mode: "allow-once" } }), false);
});

test("control preflight creates durable user-facing approval instructions", () => {
  const preflight = createControlPreflight({
    goal: "go to amazon.it and find me a good pair of jeans under 50 euro",
    mode: "ask-before-action",
    siteKey: "amazon.it",
    createId: () => "control-test",
    now: () => "2026-05-29T12:00:00.000Z"
  });

  assert.deepEqual(preflight, {
    id: "control-test",
    goal: "go to amazon.it and find me a good pair of jeans under 50 euro",
    mode: "ask-before-action",
    siteKey: "amazon.it",
    taskClass: "shopping",
    createdAt: "2026-05-29T12:00:00.000Z"
  });
  assert.equal(normalizeControlPreflight(preflight).id, "control-test");
  const message = formatControlPreflightMessage(preflight);
  assert.match(message, /Agent Control preflight required/);
  assert.match(message, /Task class: shopping/);
  assert.match(message, /Approve: \/approve-control control-test/);
  assert.match(message, /Allow class once: \/allow-control-once control-test/);
  assert.match(message, /Deny: \/deny-control control-test/);
  assert.match(message, /Still human-only: wallet, login, credential, payment/);
});
