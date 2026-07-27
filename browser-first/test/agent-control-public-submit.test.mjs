import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { approvalBoundaryForStep } from "../resonantos-side-panel-extension/src/lib/approval-policy.js";

// #240: public-submit is a non-bypassable human-only handoff. These tests prove
// the enforcement layer (content.js) refuses to auto-perform a public submit even
// with userApproved:true, and closes the search-field-in-public-form requestSubmit
// hole — the two bypasses a design red-team found surviving the naive one-liner.

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const ext = (...p) => path.join(repoRoot, "browser-first", "resonantos-side-panel-extension", "src", ...p);
const scripts = [
  ext("lib", "control-overlay.js"),
  ext("lib", "content-field-safety.js"),
  ext("lib", "content-inline-actions.js"),
  ext("lib", "content-control-refs.js"),
  ext("content.js"),
];

async function loadContentScript(html) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://shop.test/checkout" });
  const win = dom.window;
  let listener = null;
  win.chrome = {
    runtime: {
      onMessage: { addListener(cb) { listener = cb; } },
      sendMessage: () => Promise.resolve(),
    },
    storage: { onChanged: { addListener() {} } },
  };
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  win.__resonantosControlDwellMs = 0; // no spotlight dwell in tests
  for (const scriptPath of scripts) win.eval(await readFile(scriptPath, "utf8"));
  assert.equal(typeof listener, "function", "content.js should register a message listener");
  // jsdom runs "outside-only", so page scripts are inert — wire up observable state here.
  win.eval(`
    window.__submitted = false;
    window.__searchSubmitted = false;
    window.__safeClicked = false;
    document.querySelector("#public").addEventListener("submit", (e) => { e.preventDefault(); window.__submitted = true; });
    document.querySelector("#searchonly").addEventListener("submit", (e) => { e.preventDefault(); window.__searchSubmitted = true; });
    document.querySelector("#safe").addEventListener("click", () => { window.__safeClicked = true; });
  `);
  // clickElement is async (spotlight dwell before the click), so responses can
  // arrive after a microtask — resolve a promise from sendResponse.
  const send = (message) => new Promise((resolve) => {
    listener({ channel: "resonantos.browser_first.content", ...message }, {}, resolve);
  });
  return { win, send };
}

const PAGE = `<!doctype html>
  <form id="public">
    <input name="search" aria-label="Search field" placeholder="Search field">
    <input type="password" name="password" aria-label="Password">
    <button id="submit" type="submit">Submit public form</button>
  </form>
  <form id="searchonly" role="search">
    <input name="q" aria-label="Query" placeholder="Query">
    <button type="submit">Go</button>
  </form>
  <form id="commitform">
    <input name="ordersearch" aria-label="Order search" placeholder="Order search">
    <button type="submit">Place order</button>
  </form>
  <button id="publishit">Publish now</button>
  <button id="safe">Safe Details</button>
  <button id="sign" type="submit">Sign transaction</button>
  <div id="divpublish" onclick="window.__divClicked = true">Publish article</div>
  <a id="navlink" href="#orders">Order History</a>
  <a id="linkbtn" role="button" onclick="window.__linkClicked = true">Reserve seat</a>
  <div id="status">idle</div>`;

test("#240: approved click of a public submit button is denied and does not submit", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Submit public form", userApproved: true });
  assert.equal(res.ok, false, "must not click a public submit");
  assert.equal(res.deniedToAutomation, true);
  assert.equal(res.humanHandoff, true);
  assert.equal(win.__submitted, false, "the public form must NOT have been submitted");
});

test("#240: approved click of a formless commit button (Publish) is denied", async () => {
  const { send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Publish now", userApproved: true });
  assert.equal(res.ok, false);
  assert.equal(res.deniedToAutomation, true, "formless Publish must be human-only even with approval");
});

test("#240: typing+submit on a search field inside a public form is denied (requestSubmit hole)", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "type_text", field: "Search field", text: "hello", submit: true, userApproved: true });
  assert.equal(res.ok, false, "must not submit a form that also carries a password field");
  assert.equal(res.deniedToAutomation, true);
  assert.equal(win.__submitted, false, "the public form must NOT have been submitted via requestSubmit");
});

test("#240 non-breaking: typing+submit on a search-only form still works", async () => {
  const { send } = await loadContentScript(PAGE);
  const res = await send({ type: "type_text", field: "Query", text: "cats", submit: true });
  assert.equal(res.ok, true, "a search-only form remains auto-submittable");
  assert.equal(res.submitted, true);
});

test("#240 non-breaking: a benign non-submit button is still clickable", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Safe Details" });
  assert.equal(res.ok, true, "safe reads/clicks must not be blocked by #240");
  assert.equal(win.__safeClicked, true);
});

test("agent control spotlights the target before clicking and dwells so it is visible", async () => {
  const { win, send } = await loadContentScript(PAGE);
  win.__resonantosControlDwellMs = 40; // a real (short) dwell for this assertion
  const safe = win.document.querySelector("#safe");

  const pending = send({ type: "click_text", text: "Safe Details" });
  // Synchronously after dispatch: the target is spotlighted, but the click has
  // NOT fired yet — it waits for the dwell so the human can see the highlight.
  assert.equal(safe.classList.contains("resonantos-control-target"), true, "target must be spotlighted before the click");
  assert.equal(win.__safeClicked, false, "click must wait for the spotlight dwell");

  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(win.__safeClicked, true, "click fires after the dwell");
});

test("#240: a hard-boundary control (Sign) is denied by the hard check, ahead of submit", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Sign transaction", userApproved: true });
  assert.equal(res.ok, false);
  assert.equal(res.deniedToAutomation, true);
  assert.match(res.error, /wallet\/payment\/login\/credential/, "hard boundary error, checked before submit-like");
  assert.equal(win.__submitted, false);
});

test("#240: typing+submit is denied when the form holds a public-commit button (no sensitive field)", async () => {
  const { win, send } = await loadContentScript(PAGE);
  win.eval(`document.querySelector("#commitform").addEventListener("submit", (e) => { e.preventDefault(); window.__orderSubmitted = true; });`);
  const res = await send({ type: "type_text", field: "Order search", text: "widget", submit: true, userApproved: true });
  assert.equal(res.ok, false, "a form with a 'Place order' button must not be auto-submitted via a search field");
  assert.equal(res.deniedToAutomation, true);
  assert.notEqual(win.__orderSubmitted, true);
});

test("#240: an onclick commit control (div) is denied", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Publish article", userApproved: true });
  assert.equal(res.ok, false);
  assert.equal(res.deniedToAutomation, true, "a scripted <div onclick>Publish must be human-only");
  assert.notEqual(win.__divClicked, true);
});

test("#240: an <a role=button onclick> commit is denied", async () => {
  const { win, send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Reserve seat", userApproved: true });
  assert.equal(res.ok, false);
  assert.equal(res.deniedToAutomation, true);
  assert.notEqual(win.__linkClicked, true);
});

test("#240 non-breaking: a plain navigation link with a commit-word is still clickable", async () => {
  const { send } = await loadContentScript(PAGE);
  const res = await send({ type: "click_text", text: "Order History" });
  assert.equal(res.ok, true, "a plain <a href> nav link (no button semantics) must not be blocked by #240");
});

test("#240: the runner boundary classifier agrees with the widened commit verbs", () => {
  for (const verb of ["submit", "publish", "post", "send", "reserve", "order", "apply", "confirm", "connect", "subscribe", "vote"]) {
    assert.equal(approvalBoundaryForStep({ type: "click", text: `${verb} it` }), "public-submit", `${verb} → public-submit`);
  }
  // hard verbs still win over public-submit
  assert.equal(approvalBoundaryForStep({ type: "click", text: "pay now" }), "hard");
  // a plain safe action stays safe
  assert.equal(approvalBoundaryForStep({ type: "click", text: "open details" }), "safe");
});
