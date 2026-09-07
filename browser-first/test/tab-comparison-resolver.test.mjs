import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompareIntent,
  parseTabMentionTokens,
  parseTabMentions,
  resolveScopedTabs,
  resolveTabComparison
} from "../resonantos-side-panel-extension/src/lib/tab-comparison-resolver.js";

const isReadable = (tab) => /^https?:\/\//i.test(String(tab?.url ?? ""));

// Two readable tabs plus one unreadable (internal) tab — the #220 test shape.
const twoPlusUnreadable = [
  { id: 1, title: "Alpha News", url: "https://alpha.test/" },
  { id: 2, title: "Beta Report", url: "https://beta.test/" },
  { id: 3, title: "Internal Settings", url: "chrome://settings/" }
];

test("parseTabMentions extracts every unique @tab mention in order", () => {
  assert.deepEqual(parseTabMentions("compare @Alpha, @Beta, and @Internal"), ["Alpha", "Beta", "Internal"]);
  assert.deepEqual(parseTabMentions("@Alpha @alpha"), ["Alpha"], "case-insensitive de-dup");
  assert.deepEqual(parseTabMentions("no tabs here"), []);
  assert.deepEqual(parseTabMentions(""), []);
});

test("parseTabMentions honors natural 'and' phrasing (the exact Tom-flagged regression)", () => {
  // The previous pattern token greedily ate the connector word; the new shape
  // terminates unquoted tokens at whitespace.
  assert.deepEqual(parseTabMentions("compare @A and @B"), ["A", "B"]);
  assert.deepEqual(parseTabMentions("compare @A and @Beta"), ["A", "Beta"]);
  assert.deepEqual(parseTabMentions("compare @booking and @tab 2"), ["booking", "tab 2"]);
});

test("parseTabMentions preserves the @tab N form", () => {
  assert.deepEqual(parseTabMentions("use @tab 2"), ["tab 2"]);
  assert.deepEqual(parseTabMentions("compare @tab 1 and @tab 2"), ["tab 1", "tab 2"]);
});

test("parseTabMentions supports multi-word quoted titles", () => {
  assert.deepEqual(parseTabMentions('compare @"Alpha Beta" and @Beta'), ["Alpha Beta", "Beta"]);
});

test("parseTabMentions returns empty for prose containing @ that is not a tab mention", () => {
  // Email addresses and handles do not start a token with `@` so they are
  // never tokens. The previous pattern counted them as two mentions.
  assert.deepEqual(parseTabMentions("email bob@acme.com, sue@corp.io re: plan"), []);
  assert.deepEqual(parseTabMentions("contact @someone on X"), ["someone"]);
});

test("parseTabMentionTokens marks quoted, bare, and @tab N forms", () => {
  assert.deepEqual(parseTabMentionTokens('sum @"Alpha Beta" and @Beta and @tab 2'), [
    { mention: "Alpha Beta", quoted: true, tabRef: false },
    { mention: "Beta", quoted: false, tabRef: false },
    { mention: "tab 2", quoted: false, tabRef: true }
  ]);
  assert.deepEqual(parseTabMentionTokens("email bob@acme.com"), []);
});

test("resolveScopedTabs keeps token flags; resolveTabComparison strips them", () => {
  const scoped = resolveScopedTabs('sum @"Alpha News" and @"Gone Tab" and @Also Gone', twoPlusUnreadable, isReadable);
  assert.equal(scoped.items.length, 1);
  assert.equal(scoped.items[0].quoted, true, "resolved quoted mention keeps its flag");
  assert.equal(scoped.items[0].tabId, 1);
  const quotedSkip = scoped.skipped.find((entry) => entry.mention === "Gone Tab");
  const bareSkip = scoped.skipped.find((entry) => entry.mention === "Also");
  assert.equal(quotedSkip.quoted, true, "closed quoted reference is visibly explicit");
  assert.equal(bareSkip.quoted, false, "bare mention stays a prose mention");

  const comparison = resolveTabComparison('sum @"Alpha News" and @"Gone Tab"', twoPlusUnreadable, isReadable);
  assert.deepEqual(Object.keys(comparison.items[0]).sort(), ["mention", "tabId", "title", "url"].sort());
  assert.deepEqual(Object.keys(comparison.skipped[0]).sort(), ["mention", "reason", "title", "url"].sort());
});

test("isCompareIntent recognizes compare/versus/vs/diff/between (and nothing else)", () => {
  assert.equal(isCompareIntent("compare @A and @B"), true);
  assert.equal(isCompareIntent("versus @A and @B"), true);
  assert.equal(isCompareIntent("vs @A and @B"), true);
  assert.equal(isCompareIntent("diff between @A and @B"), true);
  assert.equal(isCompareIntent("difference between @A and @B"), true);
  assert.equal(isCompareIntent("@A and @B"), false, "no compare verb -> no comparison");
  assert.equal(isCompareIntent("hello @A and @B"), false);
  assert.equal(isCompareIntent(""), false);
});

test("resolveTabComparison resolves two readable tabs with title/URL provenance and skips the unreadable tab visibly", () => {
  const { items, skipped, ambiguous } = resolveTabComparison(
    "compare @Alpha, @Beta, and @Internal",
    twoPlusUnreadable,
    isReadable
  );

  assert.equal(items.length, 2);
  assert.equal(skipped.length, 1);
  assert.equal(ambiguous.length, 0);

  assert.equal(items[0].tabId, 1);
  assert.equal(items[0].title, "Alpha News");
  assert.equal(items[0].url, "https://alpha.test/");
  assert.equal(items[1].tabId, 2);
  assert.equal(items[1].title, "Beta Report");
  assert.equal(items[1].url, "https://beta.test/");

  assert.equal(skipped[0].mention, "Internal");
  assert.match(skipped[0].reason, /not a readable web page/);
  assert.match(skipped[0].reason, /Internal Settings/);
  assert.equal(skipped[0].url, "chrome://settings/");
});

test("resolveTabComparison asks for clarification on ambiguous mentions by listing candidate refs", () => {
  const tabs = [
    { id: 1, title: "BBC News", url: "https://bbc.co.uk/news" },
    { id: 2, title: "Reuters News", url: "https://reuters.com/news" }
  ];

  const { items, skipped, ambiguous } = resolveTabComparison("compare @news", tabs, isReadable);

  assert.equal(items.length, 0);
  assert.equal(skipped.length, 0);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].mention, "news");
  assert.equal(ambiguous[0].candidates.length, 2);
  const candidateTitles = ambiguous[0].candidates.map((c) => c.title);
  assert.ok(candidateTitles.includes("BBC News"));
  assert.ok(candidateTitles.includes("Reuters News"));
  assert.equal(ambiguous[0].candidates.every((c) => c.url), true, "candidates carry URL provenance");
});

test("resolveTabComparison de-duplicates mentions that resolve to the same tab via the tab-id path", () => {
  // Two DIFFERENT mention strings that resolve to the same tab exercise the
  // tab-id dedup logic; the parser-level dedup is separate.
  const { items } = resolveTabComparison("compare @Alpha @Alpha-News", twoPlusUnreadable, isReadable);
  assert.equal(items.length, 1, "tab-id dedup collapses to one item");
  assert.equal(items[0].tabId, 1);
});

test("resolveTabComparison resolves `tab N` against readable tabs and skips out-of-range positions", () => {
  const { items, skipped } = resolveTabComparison("compare @tab 2", twoPlusUnreadable, isReadable);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Beta Report");

  const outOfRange = resolveTabComparison("@tab 9", twoPlusUnreadable, isReadable);
  assert.equal(outOfRange.items.length, 0);
  assert.equal(outOfRange.skipped.length, 1);
  assert.match(outOfRange.skipped[0].reason, /no readable tab at position 9/);
});

test("resolveTabComparison is deterministic for identical input", () => {
  const a = resolveTabComparison("compare @Alpha, @Beta, and @Internal", twoPlusUnreadable, isReadable);
  const b = resolveTabComparison("compare @Alpha, @Beta, and @Internal", twoPlusUnreadable, isReadable);
  assert.deepEqual(a, b);
});

test("resolveTabComparison reports an unmatched mention rather than silently resolving nothing", () => {
  const { items, skipped } = resolveTabComparison("@Nonexistent", twoPlusUnreadable, isReadable);
  assert.equal(items.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no open tab matched this reference/);
});