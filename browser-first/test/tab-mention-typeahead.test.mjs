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

function setupDom(tabs) {
  const dom = new JSDOM('<form id="f"><textarea id="c"></textarea></form>', { url: "https://side-panel.test/" });
  const doc = dom.window.document;
  const input = doc.getElementById("c");
  const typeahead = createTabMentionTypeahead({
    doc,
    input,
    isReadableBrowserTab: isReadable,
    queryTabs: async () => tabs
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
