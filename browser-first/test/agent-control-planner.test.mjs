import assert from "node:assert/strict";
import test from "node:test";

import {
  buildControlRunbook,
  controlStepLabel,
  dedupeControlSteps,
  deterministicNextAction,
  planControlSteps
} from "../resonantos-side-panel-extension/src/lib/agent-control-planner.js";

test("agent control planner builds deterministic browser plans from user goals", () => {
  assert.deepEqual(planControlSteps("go to resonantos.com"), [
    { type: "inspect" },
    { type: "open", target: "resonantos.com" },
    { type: "read" }
  ]);

  assert.deepEqual(planControlSteps("find latest AI news on the internet"), [
    { type: "inspect" },
    { type: "search", action: "news", query: "latest AI news" },
    { type: "read" }
  ]);

  assert.deepEqual(planControlSteps("click \"Pricing\" then type \"hello\""), [
    { type: "inspect" },
    { type: "click", text: "Pricing" },
    { type: "type", text: "hello", submit: false }
  ]);

  assert.deepEqual(planControlSteps("open resonantos.com and click About"), [
    { type: "inspect" },
    { type: "open", target: "resonantos.com" },
    { type: "read" },
    { type: "click", text: "About" }
  ]);
});

test("agent control planner deduplicates repeated steps and labels actions", () => {
  assert.deepEqual(dedupeControlSteps([
    { type: "read" },
    { type: "read" },
    { type: "scroll", direction: "down" }
  ]), [
    { type: "read" },
    { type: "scroll", direction: "down" }
  ]);

  assert.equal(controlStepLabel({ type: "open", target: "https://example.com/" }), "Open https://example.com/");
  assert.equal(controlStepLabel({ type: "click", text: "Add to cart" }), 'Click "Add to cart"');
  assert.equal(controlStepLabel({ type: "type", text: "hello", field: "search" }), 'Type "hello" into search');
});

test("agent control planner provides safe next-action fallback decisions", () => {
  const first = deterministicNextAction("go to resonantos.com", { title: "Home" }, []);
  assert.equal(first.status, "continue");
  assert.deepEqual(first.action, { type: "open", target: "resonantos.com" });
  assert.equal(first.snapshotTitle, "Home");

  const second = deterministicNextAction("go to resonantos.com", { title: "Home" }, [{ action: first.action }]);
  assert.equal(second.status, "continue");
  assert.deepEqual(second.action, { type: "read" });

  const done = deterministicNextAction("go to resonantos.com", { title: "Home" }, [{ action: first.action }, { action: second.action }]);
  assert.equal(done.status, "done");
  assert.match(done.doneSummary, /Completed the safe deterministic browser steps/);

  const readFallback = deterministicNextAction("do something vague", null, []);
  assert.equal(readFallback.status, "continue");
  assert.deepEqual(readFallback.action, { type: "read" });
  assert.match(readFallback.strategyPhase, /Read the active page/);
  assert.match(readFallback.strategyRationale, /generic page control scenario runbook/);
});

test("agent control planner builds task-specific runbooks", () => {
  const dao = buildControlRunbook("review DAO vote and wallet status", {
    title: "Governance",
    url: "https://dao.example/",
    text: "Proposal 12 quorum 4%",
    controls: [{ ref: "c1", text: "Connect Wallet" }, { ref: "c2", text: "Vote For" }],
    fields: [{ ref: "f1", label: "Delegate reason" }]
  });

  assert.equal(dao.taskClass, "wallet-dao");
  assert.equal(dao.scenarioId, "dao-review");
  assert.match(dao.strategy, /DAO \/ wallet review scenario runbook/);
  assert.match(dao.currentPhase, /proposal/);
  assert.match(dao.completionCheck, /wallet\/signing actions remain human-only/);
  assert.ok(dao.preferredProbes.some((probe) => /proposal id/i.test(probe)));
  assert.ok(dao.successSignals.some((signal) => /quorum/i.test(signal)));
  assert.ok(dao.stopConditions.some((condition) => /wallet connect/i.test(condition)));
  assert.equal(dao.visibleEvidence, "2 visible controls, 1 editable fields");

  const booking = buildControlRunbook("find the next booking slot", {
    title: "Booking",
    controls: [{ ref: "slot", text: "Next available" }]
  }, [{ result: { ok: true } }]);
  assert.equal(booking.taskClass, "booking");
  assert.equal(booking.scenarioId, "booking-discovery");
  assert.match(booking.currentPhase, /Inspect visible forms/);
  assert.match(booking.historySummary, /1 successful/);
});

test("agent control planner builds real-site scenario runbooks", () => {
  const shopping = buildControlRunbook("go to amazon.it and find jeans less than €50", {
    title: "Amazon",
    text: "Search results jeans EUR 39.99 Prime",
    controls: [{ ref: "p1", text: "Levi jeans €39.99" }]
  });
  assert.equal(shopping.scenarioId, "shopping-comparison");
  assert.ok(shopping.successSignals.some((signal) => /budget/.test(signal)));
  assert.ok(shopping.stopConditions.some((condition) => /checkout/.test(condition)));

  const news = buildControlRunbook("find the most important news today", {
    title: "News Search",
    text: "Top stories Updated 2 hours ago",
    controls: [{ ref: "n1", text: "Reuters" }]
  });
  assert.equal(news.scenarioId, "news-research-synthesis");
  assert.ok(news.successSignals.some((signal) => /recency/.test(signal)));
  assert.ok(news.stopConditions.some((condition) => /recency/.test(condition)));

  const form = buildControlRunbook("type hello into the search field", {
    title: "Docs",
    fields: [{ ref: "q", label: "Search", kind: "search-query" }]
  });
  assert.equal(form.scenarioId, "safe-form-edit");
  assert.ok(form.preferredProbes.some((probe) => /classify/.test(probe)));
});
