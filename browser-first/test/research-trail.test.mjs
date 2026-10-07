import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchTrail } from "../resonantos-side-panel-extension/src/lib/research-trail.js";

const firstTime = "2026-10-07T14:00:00.000Z";
const secondTime = "2026-10-07T14:00:01.000Z";
const passage = Array.from({ length: 65 }, (_, i) => `word${i + 1}`).join(" ");

function input(overrides = {}) {
  return {
    question: "Which source supports the claim?",
    captures: [
      { snapshot: { title: "Alpha", url: "https://alpha.test/article?token=query-value#part", text: passage, links: [] }, capturedAt: firstTime },
      { snapshot: { title: "Beta", url: "https://beta.test/", text: "two words", links: [{ text: "Source", href: "https://beta.test/source" }] }, capturedAt: secondTime }
    ],
    skipped: [],
    notCaptured: { overLimit: [], nonWeb: 0 },
    ...overrides
  };
}

test("trail sources record the question, addresses, individual times and deterministic digests", () => {
  const value = input();
  const result = buildResearchTrail(value);
  assert.equal(result.title, "Research Trail: Which source supports the claim?");
  assert.deepEqual(result.counts, { captured: 2, skipped: 0, notCaptured: 0 });
  assert.ok(result.content.startsWith(`# ${result.title}\n- research question: Which source supports the claim?`));
  assert.ok(result.content.includes(`- collected: ${firstTime} · sources captured: 2 · skipped: 0 · not captured: 0`));
  assert.ok(result.content.includes(`### 1. Alpha\n- address: https://alpha.test/article\n- captured at: ${firstTime}\n- 65 words · 0 links`));
  assert.ok(result.content.includes(`### 2. Beta\n- address: https://beta.test/\n- captured at: ${secondTime}\n- 2 words · 1 links`));
  assert.equal(result.content.split("\n").find((line) => line.startsWith("> ")), `> ${passage.split(" ").slice(0, 60).join(" ")}`);
  assert.doesNotMatch(result.content, /query-value|#part|Skipped and not captured/);
  assert.ok(result.content.endsWith("## Review\nRaw source material, queued for review. Nothing was written to trusted memory."));
  assert.equal(buildResearchTrail(value).content, result.content);
  assert.deepEqual(buildResearchTrail(value), buildResearchTrail(structuredClone(value)));
});

test("trail scrubs page text before rendering both the opening passage and body", () => {
  const result = buildResearchTrail(input({ captures: [{
    capturedAt: firstTime,
    snapshot: { title: "Text", url: "https://text.test/", text: "Opening Authorization: Bearer bearer-token-value-0123456789 closing", links: [] }
  }] }));
  assert.doesNotMatch(result.content, /bearer-token-value-0123456789/);
  assert.ok(result.content.includes("> Opening Authorization: Bearer [redacted] closing\nOpening Authorization: Bearer [redacted] closing"));
});

test("trail uses none given and omits empty source, passage, link and skipped sections", () => {
  const empty = buildResearchTrail(input({ question: "", captures: [] }));
  assert.equal(empty.title, "Browser research trail");
  assert.ok(empty.content.startsWith("# Browser research trail\n- research question: none given\n"));
  assert.doesNotMatch(empty.content, /## Sources|## Skipped and not captured|collected:/);
  assert.deepEqual(empty.counts, { captured: 0, skipped: 0, notCaptured: 0 });
  const source = buildResearchTrail(input({ question: "", captures: [{
    snapshot: { title: "Empty", url: "https://empty.test/", text: "", links: [] }, capturedAt: firstTime
  }] }));
  assert.doesNotMatch(source.content, /^> |Source Links|Skipped and not captured/m);
  assert.match(source.content, /0 words · 0 links/);
});

test("trail scrubs all source fields and links while capping the body at 6000 characters", () => {
  const secret = "bearer-token-value-0123456789";
  const credential = `Authorization: Bearer ${secret}`;
  const result = buildResearchTrail(input({
    question: `Question ${credential}`,
    captures: [{
      capturedAt: firstTime,
      snapshot: {
        title: `Title ${credential}`,
        url: `https://reader:password-value@alpha.test/article?token=${secret}#private-fragment`,
        text: `${"x ".repeat(3000)}TAIL ${credential}`,
        links: [
          { text: `Link ${credential}`, href: `https://reader:password-value@links.test/source?token=${secret}#private-fragment` },
          { text: "Local action", href: "javascript:alert(1)" }
        ]
      }
    }]
  }));
  assert.doesNotMatch(result.content, /bearer-token-value-0123456789|password-value|private-fragment|TAIL|javascript:/);
  assert.ok(result.content.includes("- research question: Question Authorization: Bearer [redacted]"));
  assert.ok(result.content.includes("### 1. Title Authorization: Bearer [redacted]"));
  assert.ok(result.content.includes("- address: https://alpha.test/article"));
  assert.ok(result.content.includes("- [Link Authorization: Bearer [redacted]](https://links.test/source)"));
  assert.equal(result.content.split("\n").find((line) => line.startsWith("x x ")), "x ".repeat(3000));
  assert.match(result.content, /- 3004 words · 2 links/);
});



test("trail grades failed, blocked, permission-unknown and over-limit tabs without blocked metadata", () => {
  const result = buildResearchTrail(input({
    skipped: [
      { tab: { title: "Failed Authorization: Bearer bearer-token-value-0123456789", url: "https://failed.test/path?token=query-value#part" }, kind: "failed", error: "Read failed Authorization: Bearer bearer-token-value-0123456789" },
      { tab: { title: "Blocked private title", url: "https://blocked.test:8443/private-path?token=query-value" }, kind: "blocked", error: "Assistant is blocked on blocked.test:8443." },
      { tab: { title: "Unknown private title", url: "https://unknown.test/private-unknown" }, kind: "blocked", error: "Site permissions could not be read; capture refused." }
    ],
    notCaptured: {
      overLimit: [{ title: "Ninth Authorization: Bearer bearer-token-value-0123456789", url: "https://ninth.test/path?token=query-value#part" }],
      nonWeb: 2
    }
  }));
  assert.deepEqual(result.counts, { captured: 2, skipped: 3, notCaptured: 3 });
  assert.ok(result.content.includes("## Skipped and not captured"));
  assert.ok(result.content.includes("- Could not read: Failed Authorization: Bearer [redacted] — https://failed.test/path — Read failed Authorization: Bearer [redacted]"));
  assert.ok(result.content.includes("- Blocked by your site permission: blocked.test\n- Blocked by your site permission: unknown.test"));
  assert.ok(result.content.includes("- Over the 8-tab limit: Ninth Authorization: Bearer [redacted] — https://ninth.test/path"));
  assert.ok(result.content.includes("- Non-web tabs not captured: 2"));
  assert.doesNotMatch(result.content, /Blocked private title|Unknown private title|private-path|private-unknown|8443|query-value|bearer-token-value-0123456789|capture refused/);
});

test("trail keeps the scrubbed question as typed and shortens only its title component", () => {
  const question = `Compare  sources: ${"a".repeat(100)}`;
  const result = buildResearchTrail(input({ question }));
  assert.equal(result.title, `Research Trail: ${question.slice(0, 80)}`);
  assert.ok(result.content.includes(`- research question: ${question}\n`));
  const whitespace = buildResearchTrail(input({ question: "  Compare   these  sources  " }));
  assert.ok(whitespace.content.includes("- research question: Compare  these  sources\n"));
});



test("a blocked tab with a malformed or missing address never aborts the trail and never leaks its title", () => {
  const trail = buildResearchTrail(input({
    skipped: [
      { tab: { title: "Malformed private title", url: "not a url" }, kind: "blocked", error: "Assistant is blocked on not a url." },
      { tab: { title: "Missing private title" }, kind: "blocked", error: "Site permissions could not be read; capture refused." }
    ]
  }));
  assert.equal((trail.content.match(/- Blocked by your site permission: unknown site/g) ?? []).length, 2);
  assert.doesNotMatch(trail.content, /Malformed private title|Missing private title|not a url/);
  assert.equal(trail.counts.skipped, 2);
});
