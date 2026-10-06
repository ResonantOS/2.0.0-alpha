// #252 — the composer typeahead lists only open, permitted tabs and inserts
// the deliberate @"…" mention form that the router treats as an explicit scope.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  createTabMentionTypeahead,
  mentionInsertionForTab,
  mentionQueryAtCaret,
  rankMentionCandidates
} from "../resonantos-side-panel-extension/src/lib/tab-mention-typeahead.js";

const isReadable = (tab) => /^https?:\/\//i.test(String(tab?.url ?? ""));

const openTabs = [
  { id: 1, title: "Alpha News", url: "https://alpha.test/" },
  { id: 2, title: "Beta Report", url: "https://beta.test/" },
  { id: 3, title: "Internal Settings", url: "chrome://settings/" },
  { id: 4, title: "Alpha Docs", url: "https://docs.alpha.test/" }
];

test("mentionQueryAtCaret detects mention tokens at the caret", () => {
  assert.deepEqual(mentionQueryAtCaret("@", 1), { start: 0, query: "", quoted: false });
  assert.deepEqual(mentionQueryAtCaret("sum @Al", 7), { start: 4, query: "Al", quoted: false });
  assert.deepEqual(mentionQueryAtCaret('sum @"Alpha Be', 14), { start: 4, query: "Alpha Be", quoted: true });
});

test("mentionQueryAtCaret rejects prose, emails, and terminated tokens", () => {
  assert.equal(mentionQueryAtCaret("bob@acme.com", 9), null);
  assert.equal(mentionQueryAtCaret("no mention here", 15), null);
  assert.equal(mentionQueryAtCaret("@Alpha Beta", 11), null, "unquoted token terminated at whitespace");
  assert.equal(mentionQueryAtCaret('closed @"Done" already', 14), null);
});

test("rankMentionCandidates lists only readable tabs, prefix before substring before URL", () => {
  const all = rankMentionCandidates(openTabs, "", isReadable);
  assert.deepEqual(all.map((candidate) => candidate.title), ["Alpha News", "Beta Report", "Alpha Docs"], "chrome:// internal tab is never listed");
  assert.deepEqual(all.map((candidate) => candidate.index), [1, 2, 3], "index is the position among readable tabs for @tab N");

  const prefix = rankMentionCandidates(openTabs, "alpha", isReadable);
  assert.deepEqual(prefix.map((candidate) => candidate.title), ["Alpha News", "Alpha Docs"]);

  const substring = rankMentionCandidates(openTabs, "docs", isReadable);
  assert.deepEqual(substring.map((candidate) => candidate.title), ["Alpha Docs"]);

  assert.deepEqual(rankMentionCandidates(openTabs, "missing", isReadable), []);
});

test("mentionInsertionForTab inserts the deliberate quoted form and sanitizes titles", () => {
  assert.equal(mentionInsertionForTab({ title: "Alpha News", index: 1 }), '@"Alpha News" ');
  assert.equal(mentionInsertionForTab({ title: 'He said "hi"\nthere', index: 2 }), '@"He said hi there" ');
  assert.equal(mentionInsertionForTab({ title: "", index: 3 }), "@tab 3 ", "untitled tab falls back to the ranked form");
});

function setupDom(tabs, { debounceMs = 0, queryTabs } = {}) {
  const dom = new JSDOM('<form id="f"><textarea id="c"></textarea></form>', { url: "https://side-panel.test/" });
  const doc = dom.window.document;
  const input = doc.getElementById("c");
  const typeahead = createTabMentionTypeahead({
    doc,
    input,
    isReadableBrowserTab: isReadable,
    // debounceMs 0 keeps refresh synchronous so tests stay deterministic.
    debounceMs,
    queryTabs: queryTabs ?? (async () => tabs)
  });
  return { doc, dom, input, typeahead };
}

const keydown = (dom, key) => new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });

const typeAndRefresh = async (dom, input, value) => {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("typeahead opens on @ over permitted tabs and inserts the quoted mention on Enter", async () => {
  const { doc, dom, input, typeahead } = setupDom(openTabs);

  await typeAndRefresh(dom, input, "sum @Al");
  const list = doc.querySelector(".tab-mention-typeahead");
  assert.ok(list, "dropdown renders");
  assert.equal(typeahead.isOpen(), true);
  const options = [...list.querySelectorAll(".tab-mention-option")];
  assert.deepEqual(options.map((option) => option.querySelector("strong").textContent), ["Alpha News", "Alpha Docs"]);
  assert.match(options[0].querySelector("span").textContent, /@tab 1 · alpha\.test/);

  input.dispatchEvent(keydown(dom, "Enter"));
  assert.equal(input.value, 'sum @"Alpha News" ');
  assert.equal(typeahead.isOpen(), false);
  assert.equal(doc.querySelector(".tab-mention-typeahead"), null);
  assert.equal(input.selectionStart, input.value.length, "caret lands after the inserted mention");
});

test("typeahead arrow navigation selects a later candidate", async () => {
  const { doc, dom, input, typeahead } = setupDom(openTabs);

  await typeAndRefresh(dom, input, "@");
  assert.equal(doc.querySelectorAll(".tab-mention-option").length, 3);

  input.dispatchEvent(keydown(dom, "ArrowDown"));
  assert.equal(doc.querySelector(".tab-mention-option.active strong").textContent, "Beta Report");
  input.dispatchEvent(keydown(dom, "Enter"));
  assert.equal(input.value, '@"Beta Report" ');
  assert.equal(typeahead.isOpen(), false);
});

test("typeahead does not open for email prose and closes on Escape", async () => {
  const { doc, dom, input, typeahead } = setupDom(openTabs);

  await typeAndRefresh(dom, input, "mail bob@acme");
  assert.equal(typeahead.isOpen(), false);
  assert.equal(doc.querySelector(".tab-mention-typeahead"), null);

  await typeAndRefresh(dom, input, "@");
  assert.equal(typeahead.isOpen(), true);
  input.dispatchEvent(keydown(dom, "Escape"));
  assert.equal(typeahead.isOpen(), false);
  assert.equal(input.value, "@", "Escape leaves the composer text untouched");
});

test("typeahead closes when the query stops matching any permitted tab", async () => {
  const { doc, dom, input, typeahead } = setupDom(openTabs);

  await typeAndRefresh(dom, input, "@Al");
  assert.equal(typeahead.isOpen(), true);
  await typeAndRefresh(dom, input, "@Alzzzz");
  assert.equal(typeahead.isOpen(), false);
  assert.equal(doc.querySelector(".tab-mention-typeahead"), null);
});

test("typeahead keeps the textarea's native role and exposes aria-activedescendant (#410 a11y)", async () => {
  const { doc, dom, input } = setupDom(openTabs);

  // ARIA-in-HTML forbids any role override on a <textarea> (only its native
  // textbox is allowed), so the typeahead must NOT set role="combobox"; it
  // conveys the popup via supported states instead.
  assert.equal(input.getAttribute("role"), null, "no invalid role override on the textarea");
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  assert.equal(input.getAttribute("aria-expanded"), "false");

  await typeAndRefresh(dom, input, "@");
  const list = doc.querySelector(".tab-mention-typeahead");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(input.getAttribute("aria-controls"), list.id);
  assert.ok(list.id, "listbox has an id for aria-controls");
  const first = doc.querySelector(".tab-mention-option");
  assert.equal(input.getAttribute("aria-activedescendant"), first.id, "active option tracked via virtual focus");
  assert.equal(first.getAttribute("aria-selected"), "true");

  input.dispatchEvent(keydown(dom, "ArrowDown"));
  const options = [...doc.querySelectorAll(".tab-mention-option")];
  assert.equal(input.getAttribute("aria-activedescendant"), options[1].id, "aria-activedescendant follows arrow navigation");
  assert.equal(options[1].getAttribute("aria-selected"), "true");
  assert.equal(options[0].getAttribute("aria-selected"), "false");

  input.dispatchEvent(keydown(dom, "Escape"));
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null, "virtual focus cleared on close");
  assert.equal(input.getAttribute("aria-controls"), null);
});

test("Tab dismisses the dropdown without committing so focus can move on (#410 keyboard)", async () => {
  const { doc, dom, input, typeahead } = setupDom(openTabs);

  await typeAndRefresh(dom, input, "@Al");
  assert.equal(typeahead.isOpen(), true);

  const event = keydown(dom, "Tab");
  input.dispatchEvent(event);
  assert.equal(typeahead.isOpen(), false, "Tab closes the dropdown");
  assert.equal(input.value, "@Al", "Tab does not insert a mention");
  assert.equal(event.defaultPrevented, false, "default Tab focus move is preserved");
  assert.equal(doc.querySelector(".tab-mention-typeahead"), null);
});

test("input-triggered refresh is debounced so a keystroke burst queries tabs once (#410 perf)", async () => {
  let queryCount = 0;
  const { dom, input, typeahead } = setupDom(openTabs, {
    debounceMs: 15,
    queryTabs: async () => {
      queryCount += 1;
      return openTabs;
    }
  });

  for (const value of ["@", "@A", "@Al", "@Alp"]) {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  }
  assert.equal(queryCount, 0, "no query fires synchronously during the burst");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(queryCount, 1, "the coalesced refresh queries tabs exactly once");
  assert.equal(typeahead.isOpen(), true);
});

test("a stale debounced popup never erases text or swallows Enter (#410 regression)", async () => {
  const { dom, input, typeahead } = setupDom(openTabs, { debounceMs: 15 });

  // Open the popup for "@A".
  input.value = "@A";
  input.setSelectionRange(2, 2);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typeahead.isOpen(), true, "popup is open for @A");

  // Type past the mention (a space ends the unquoted token) and press Enter
  // while the debounce timer for this keystroke is still pending.
  input.value = "@A hello";
  input.setSelectionRange(8, 8);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(typeahead.isOpen(), false, "popup closes synchronously once the caret leaves the mention");

  const enter = keydown(dom, "Enter");
  input.dispatchEvent(enter);
  assert.equal(input.value, "@A hello", "the user's text is not erased by a stale suggestion");
  assert.equal(enter.defaultPrevented, false, "Enter is not swallowed — it falls through to the composer's submit");
});

test("selectCandidate refuses to commit when the caret no longer sits in the ranked mention (#410)", async () => {
  // Open on a valid mention, then move the caret out of it without firing the
  // debounced input refresh, and confirm an Enter does not commit or swallow.
  const { dom, input, typeahead } = setupDom(openTabs, { debounceMs: 15 });

  input.value = "@Al";
  input.setSelectionRange(3, 3);
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typeahead.isOpen(), true);

  // Caret jumps to the very start (position 0) — before the mention's "@".
  input.setSelectionRange(0, 0);
  const enter = keydown(dom, "Enter");
  input.dispatchEvent(enter);
  assert.equal(input.value, "@Al", "no mention is inserted when the caret is outside the ranked mention");
  assert.equal(enter.defaultPrevented, false, "Enter falls through rather than committing a stale candidate");
  assert.equal(typeahead.isOpen(), false, "the stale popup is closed");
});
