import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { renderStepList, stepListProgress } from "../resonantos-side-panel-extension/src/lib/step-list.js";

function container() {
  const dom = new JSDOM(`<!doctype html><div id="host"></div>`);
  return { document: dom.window.document, host: dom.window.document.getElementById("host") };
}

const steps = [
  { label: "Gather requirements", state: "completed" },
  { label: "Propose approaches", state: "completed" },
  { label: "Present the design", state: "active" },
  { label: "Commit the spec", state: "pending" }
];

test("stepListProgress counts completed steps against the total", () => {
  assert.deepEqual(stepListProgress(steps), { done: 2, total: 4 });
  assert.deepEqual(stepListProgress([]), { done: 0, total: 0 });
  assert.deepEqual(stepListProgress(null), { done: 0, total: 0 });
});

test("renderStepList renders one item per step with its state and 1-based index", () => {
  const { document, host } = container();
  renderStepList(host, steps, { document });

  const items = [...host.querySelectorAll(".step-list-item")];
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((item) => item.dataset.state), ["completed", "completed", "active", "pending"]);
  assert.deepEqual(items.map((item) => item.dataset.index), ["1", "2", "3", "4"]);
  assert.equal(items[2].querySelector(".step-list-num").textContent, "3.");
  assert.equal(items[2].querySelector(".step-list-label").textContent, "Present the design");
});

test("renderStepList shows a progress pill that is active while a step runs", () => {
  const { document, host } = container();
  renderStepList(host, steps, { document });

  const pill = host.querySelector(".step-list-pill");
  assert.equal(pill.querySelector(".step-list-pill-text").textContent, "2 of 4");
  assert.equal(pill.dataset.active, "true", "an in-progress step spins the pill");
  assert.match(pill.getAttribute("aria-label"), /2 of 4 steps complete/);
});

test("renderStepList marks the pill idle when nothing is running", () => {
  const { document, host } = container();
  renderStepList(host, [
    { label: "One", state: "completed" },
    { label: "Two", state: "completed" }
  ], { document });

  const pill = host.querySelector(".step-list-pill");
  assert.equal(pill.querySelector(".step-list-pill-text").textContent, "2 of 2");
  assert.equal(pill.dataset.active, "false");
});

test("renderStepList replaces prior content on re-render", () => {
  const { document, host } = container();
  renderStepList(host, steps, { document });
  renderStepList(host, [{ label: "Only step", state: "pending" }], { document });
  assert.equal(host.querySelectorAll(".step-list-item").length, 1);
  assert.equal(host.querySelector(".step-list-pill-text").textContent, "0 of 1");
});

test("renderStepList defaults an unknown state to pending", () => {
  const { document, host } = container();
  renderStepList(host, [{ label: "Mystery" }], { document });
  assert.equal(host.querySelector(".step-list-item").dataset.state, "pending");
});

test("renderStepList gives each step a screen-reader state text", async () => {
  const { document, host } = container();
  renderStepList(host, [
    { label: "Done step", state: "completed" },
    { label: "Running step", state: "active" },
    { label: "Waiting step", state: "pending" }
  ], { document });

  const sr = [...host.querySelectorAll(".step-list-item .step-list-sr")].map((s) => s.textContent.trim());
  assert.deepEqual(sr, ["— done", "— in progress", "— pending"]);
});

test("renderStepList keeps a stable progress pill across re-renders (live region persists)", () => {
  const { document, host } = container();
  renderStepList(host, steps, { document });
  const firstPill = host.querySelector(".step-list-pill");
  renderStepList(host, [{ label: "Only", state: "active" }], { document });
  const secondPill = host.querySelector(".step-list-pill");

  assert.equal(host.querySelectorAll(".step-list-pill").length, 1, "no duplicate pills");
  assert.equal(firstPill, secondPill, "the role=status node is reused, not rebuilt");
  assert.equal(secondPill.querySelector(".step-list-pill-text").textContent, "0 of 1");
  assert.equal(secondPill.dataset.active, "true");
});

test("renderStepList carries explicit list semantics for VoiceOver", () => {
  const { document, host } = container();
  renderStepList(host, steps, { document });
  assert.equal(host.querySelector("ol.step-list").getAttribute("role"), "list");
  assert.deepEqual(
    [...host.querySelectorAll(".step-list-item")].map((item) => item.getAttribute("role")),
    ["listitem", "listitem", "listitem", "listitem"]
  );
});

test("renderExtra attaches per-step content in a slot that clears the glyph column", () => {
  const { document, host } = container();
  renderStepList(host, steps, {
    document,
    // Only the third step gets extra content; the rest return null.
    renderExtra: (step, index) => {
      if (index !== 2) return null;
      const note = document.createElement("span");
      note.className = "probe-detail";
      note.textContent = `detail for ${step.label}`;
      return note;
    }
  });
  const slots = host.querySelectorAll(".step-list-extra");
  assert.equal(slots.length, 1, "renderExtra returning null adds no slot");
  const item = host.querySelectorAll(".step-list-item")[2];
  assert.equal(item.querySelector(".step-list-extra .probe-detail").textContent, "detail for Present the design");
});
