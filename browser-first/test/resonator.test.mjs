import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const resonatorPath = path.join(
  repoRoot,
  "browser-first",
  "resonantos-side-panel-extension",
  "src",
  "lib",
  "resonator.js",
);

async function loadResonator(html = "<!doctype html><button id='target'>Target</button>") {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  dom.window.eval(await readFile(resonatorPath, "utf8"));
  return dom;
}

test("Resonator exposes restored visual guidance commands", async () => {
  const dom = await loadResonator();
  assert.equal(typeof dom.window.Resonator.highlight, "function");
  assert.equal(typeof dom.window.Resonator.arrow, "function");
  assert.equal(typeof dom.window.Resonator.spotlight, "function");
  assert.equal(typeof dom.window.Resonator.step, "function");
  assert.equal(typeof dom.window.Resonator.clear, "function");
});

test("Resonator is idempotent and clear restores highlighted elements", async () => {
  const dom = await loadResonator();
  const source = await readFile(resonatorPath, "utf8");
  dom.window.eval(source);
  assert.equal(dom.window.document.querySelectorAll("#resonator-styles").length, 1);

  const target = dom.window.document.querySelector("#target");
  const result = dom.window.Resonator.highlight({ selector: "#target", duration: 5000 });
  assert.equal(result.ok, true);
  assert.equal(target.getAttribute("data-resonator"), "highlight");

  dom.window.Resonator.clear();
  assert.equal(target.hasAttribute("data-resonator"), false);
});
