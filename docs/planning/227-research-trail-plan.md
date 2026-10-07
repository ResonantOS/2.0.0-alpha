# Research Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/trail <question>` save a scrubbed, deterministic, reviewable record of the current window's captured and uncaptured tabs, then request Living Archive review.

**Architecture:** A pure `buildResearchTrail` module owns formatting and reuses the chat context scrubbers. The existing browser-page-actions factory owns permission-governed reads, injected capture times, and the two sequential archive calls. Promotion remains separate; the live lane verifies the real command and visible saved path.

**Tech Stack:** Plain JavaScript ES modules, Chrome MV3 APIs, Node.js `node:test`/strict assertions, existing CDP/Playwright live harness; no new dependencies.

## Global Constraints

The following decisions and boundary requirements are copied verbatim from the approved spec, `docs/planning/227-research-trail-design.md`:

1. **No model at save time.** Each source gets a deterministic digest: address,
   capture time, word and link counts, and an opening passage: the first 60 words of the visible text.
   Synthesis belongs to the review step. Headings are out of scope: captured
   snapshots carry none, and adding them would change the content script.
2. **Skipped tabs are graded by reason.** Failed reads and tabs over the limit keep
   title, address (query string and fragment removed) and reason. Blocked sites keep
   **domain and reason only**. A tab whose site permission could not be read is
   treated as blocked, because the user may have blocked it. Non-web tabs are
   counted, never listed.
3. **A pure builder module.** Formatting moves out of the 1,115-line
   `browser-page-actions.js` into a small module with no browser or network access.

Every string that enters `content` passes through the chat path's scrubbers
(`safeContextText`, `safeContextUrl` from `chat-turn-controller.js`), including the
question, titles, page text and link text. For a blocked tab only
`new URL(url).hostname` is written. The same inputs always produce byte-identical
output; the module never reads the clock.

5. Build the trail, then call `/archive/intake` and `/archive/review/request` (same
   origin `browser-research-trail` as today). No other route.

Nothing is written to trusted memory;
promotion stays a separate, human-reviewed step.

Model-written summaries, page headings, a JSON sidecar artifact (needs a host
change to `/archive/intake`), raising the 8-tab limit, and any change to promotion.

The last paragraph is the spec's **Out of scope** list. Additional execution constraints: keep the existing ES module style; add no dependency or scrubber; use hygiene-safe synthetic strings; use `node --test <file>` for focused checks. `npm run test:browser-first` discovers every `.test.mjs` and does not forward path arguments.

---

## Repository grounding and file map

Planning baseline: branch `feat/227-research-trail`, HEAD `ed95e99c` (dev base). The approved design is untracked and `docs/planning/README.md` is already modified. Preserve both; none of the implementation commits below stages them implicitly. This planning operation writes only this plan. Commands and source edits below are instructions for later execution, not changes made while planning.

Read the root AGENTS/README/INSTALL/CONTRIBUTING/docs router, `browser-first/README.md`, module ownership, and ADR-007/011/012 before execution. For this issue the approved design alone defines product requirements; these other documents supply repository and boundary rules, not additional features.

| File | Responsibility and planned change |
| --- | --- |
| `browser-first/resonantos-side-panel-extension/src/lib/research-trail.js` | New pure formatter; all dynamic persisted strings use existing scrubbers. |
| `browser-first/test/research-trail.test.mjs` | New pure builder contract and mutation-sensitive privacy assertions. |
| `browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js` | Existing factory, reads and archive orchestration; remove old formatter. |
| `browser-first/test/browser-page-actions.test.mjs` | Extend the real `createHarness` with `now`; update both existing trail tests; add failure rows. |
| `docs/architecture/MODULE-OWNERSHIP.md` | Record the formatter's responsibility transfer in Task 1, required by AGENTS. |
| `browser-first/test/agent-control-live.mjs` | Add one fixture `/trail` proof in the common profile path. |

Read-only grounding files: `src/lib/chat-turn-controller.js`, `src/lib/side-panel-command-router.js`, `src/lib/side-panel-browser-action-controller.js` under the extension; `scripts/run-browser-first-extension-tests.mjs`; `scripts/browser-first-release-scope-audit.mjs`; `.github/workflows/agent-control-live.yml`; `browser-first/host/archive-review-service.mjs`. No edits to these are needed.

Verified integration facts:

- Factory dependency destructuring is at `browser-page-actions.js:111`; `getLastSnapshot = () => null` demonstrates default injection. Add `now` there, not a global clock or a new production composition argument.
- `readSpecificTabPage` at line 289 returns `Tab is not a readable web page.`, `Site permissions could not be read; capture refused.`, or `Assistant is blocked on ${siteKeyForUrl(tab.url)}.`. Preserve these exact existing strings and permission checks.
- Frame reads run through `chrome.tabs.sendMessage`, may inject and retry once, and normalize unsuccessful frame responses to `No readable frame returned page context.`. Tests must stub `sendMessage` and `permissionForUrl`, not replace the lexical `readSpecificTabPage` function.
- `createHarness` records `['bridge', route, options]` before calling its `bridgeRequest` override, queries `overrides.tabs`, and stores `lastSnapshot` through getters/setters. Trail reads must ignore cached `lastSnapshot`. Default frames contain only frame 0, so one successful read corresponds to one `sendMessage` event.
- `/trail` and `/researchtrail` at `side-panel-command-router.js:74` call `handlers.saveIntake(\`trail ${body}\`.trim())`. Strip only that leading command token (and preserve existing intake aliases); the remainder is the question, not merely a title.
- `safeContextText(value, max = 1000)` scrubs, collapses runs of three or more whitespace characters to two spaces, trims, then slices. Use `Infinity` for fields without a specified length cap; shorten the title's question to 80 and visible source text to 6,000. Do not normalize ordinary internal spacing beyond that helper.
- `safeContextUrl` removes userinfo, query, and hash from valid HTTP(S) URLs and returns `""` for valid non-HTTP(S) URLs. Its malformed-input catch returns a scrubbed fallback. Reuse this implementation unchanged; the input tabs are already readable HTTP(S) tabs.
- `classify` in `scripts/browser-first-release-scope-audit.mjs` includes any `changedPath.startsWith("browser-first/")`; it also includes planning docs and the ownership map. The new file is already allowed: **no allowlist edit**.

### Concrete format/copy interpretations

These resolve details the spec does not fully spell out without adding behavior:

- `collected` uses the first captured source's caller-supplied timestamp. No extra clock read. With no captures, omit the collected time, Sources section, and source-only content; the orchestrator never saves such a bundle.
- Word count and opening passage use the complete scrubbed visible text before the 6,000-character body cap. Link count is the snapshot's link count. Retain the old formatter's maximum of eight displayed source links, scrubbing both label and URL; this grounds the spec's link-text requirement in existing behavior.
- Shorten the question component to 80 characters, yielding `Research Trail: ${question.slice(0, 80)}`; with an empty question both returned title and H1 are `Browser research trail`.
- Preserve the complete existing no-readable-tabs message: `No readable browser tabs are available for a research trail. Open one or more normal web pages first.` The spec abbreviates it as `No readable browser tabs…` and says unchanged.
- On all failed reads, use that same complete message followed by reason counts: `Blocked: N; failed: M; over the 8-tab limit: K; non-web: L.` This suffix implements the requested counts; its exact punctuation is not specified by the design.
- Successful feedback uses the spec's exact `Saved a N-page trail; M tabs skipped`, then the saved path, exact Review sentence, and existing `reviewQueueGuidance`. Noncaptured counts remain in the saved content and numeric result.
- Intake failure uses exactly `Could not save the research trail: <reason>. Nothing was saved.` with a scrubbed reason. Review failure uses exactly `Saved to <path>, but it could not be queued for review; ask again with `/trail` or queue it from the archive.`. Do not invent recovery copy.

### Task 1: Pure research trail builder and contracts

**Files:**
- Create: `browser-first/resonantos-side-panel-extension/src/lib/research-trail.js`
- Create/Test: `browser-first/test/research-trail.test.mjs`
- Modify: `docs/architecture/MODULE-OWNERSHIP.md` (Alpha Ownership table, after browser-page-actions row)

**Interfaces:**
- Consumes: `safeContextText(value, max = 1000): string`, `safeContextUrl(value): string` from `./chat-turn-controller.js`.
- Produces: `buildResearchTrail({ question, captures, skipped, notCaptured }): { title: string, content: string, counts: { captured: number, skipped: number, notCaptured: number } }`.
- `question: string`; `captures: Array<{ snapshot: { title?: string, url?: string, text?: string, links?: Array<{ text?: string, href?: string }> }, capturedAt: string }>`; `skipped: Array<{ tab: { title?: string, url: string }, kind: 'failed' | 'blocked', error: string }>`; `notCaptured: { overLimit: Array<{ title?: string, url: string }>, nonWeb: number }`.
- Caller supplies ISO UTC capture times. `skipped` counts failed attempted reads; `notCaptured` counts over-limit plus non-web tabs, without double counting. Defaults permit empty arrays.

**Deliverable:** An independently testable formatter with no runtime wiring yet.

- [ ] **Step 1: Write the first failing builder contracts.** Create this test file:

```js
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
```

- [ ] **Step 2: Run the red test.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: FAIL, module `research-trail.js` cannot be found.

- [ ] **Step 3: Implement the source digest and initial builder.** Create the complete module below. Later steps replace the named functions with their complete final versions.

```js
import { safeContextText, safeContextUrl } from "./chat-turn-controller.js";

function sourceMarkdown({ snapshot, capturedAt }, index) {
  const text = safeContextText(snapshot.text, Infinity);
  const words = text.split(/\s+/).filter(Boolean);
  return [
    `### ${index + 1}. ${safeContextText(snapshot.title || "Untitled", Infinity)}`,
    `- address: ${safeContextText(safeContextUrl(snapshot.url), Infinity)}`,
    `- captured at: ${safeContextText(capturedAt, Infinity)}`,
    `- ${words.length} words · ${(snapshot.links ?? []).length} links`,
    words.length ? `> ${words.slice(0, 60).join(" ")}` : "",
    text
  ].filter(Boolean).join("\n");
}

export function buildResearchTrail({ question = "", captures = [], skipped = [], notCaptured = { overLimit: [], nonWeb: 0 } }) {
  const safeQuestion = safeContextText(question, Infinity);
  const title = safeQuestion ? `Research Trail: ${safeQuestion}` : "Browser research trail";
  const counts = { captured: captures.length, skipped: 0, notCaptured: 0 };
  const collected = captures.length ? `collected: ${safeContextText(captures[0].capturedAt, Infinity)} · ` : "";
  const content = [
    `# ${title}`,
    `- research question: ${safeQuestion || "none given"}`,
    `- ${collected}sources captured: ${counts.captured} · skipped: ${counts.skipped} · not captured: ${counts.notCaptured}`,
    captures.length ? `\n## Sources\n${captures.map(sourceMarkdown).join("\n\n")}` : "",
    "\n## Review\nRaw source material, queued for review. Nothing was written to trusted memory."
  ].filter(Boolean).join("\n");
  return { title, content, counts };
}
```

- [ ] **Step 4: Run the builder test.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add failing privacy/link/cap tests.** Append:

```js
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


```

- [ ] **Step 6: Run the red tests.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: FAIL for retained `TAIL` and missing scrubbed link. The page-text-only contract was first written red before creating the module; Step 18 also proves its scrubber-removal sensitivity.

- [ ] **Step 7: Replace `sourceMarkdown` with this final implementation.** The opening passage remains first 60 words of the complete scrubbed text; only the separate visible body gets the character cap.

```js
function sourceMarkdown({ snapshot, capturedAt }, index) {
  const text = safeContextText(snapshot.text, Infinity);
  const words = text.split(/\s+/).filter(Boolean);
  const links = (snapshot.links ?? []).slice(0, 8).map((link) => {
    const href = safeContextText(safeContextUrl(link.href), Infinity);
    if (!href) return "";
    return `- [${safeContextText(link.text || href, Infinity)}](${href})`;
  }).filter(Boolean);
  return [
    `### ${index + 1}. ${safeContextText(snapshot.title || "Untitled", Infinity)}`,
    `- address: ${safeContextText(safeContextUrl(snapshot.url), Infinity)}`,
    `- captured at: ${safeContextText(capturedAt, Infinity)}`,
    `- ${words.length} words · ${(snapshot.links ?? []).length} links`,
    words.length ? `> ${words.slice(0, 60).join(" ")}` : "",
    text.slice(0, 6000),
    links.length ? `#### Source Links\n${links.join("\n")}` : ""
  ].filter(Boolean).join("\n");
}
```

- [ ] **Step 8: Run the builder tests.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: PASS. The first 60 words are all `x`; the capped body contains 3,000 `x ` pairs and omits the tail. Word count covers all 3,004 scrubbed words.

- [ ] **Step 9: Add a failing graded-skips test.** Append:

```js
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
```

- [ ] **Step 10: Run the red test.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: FAIL, skipped and notCaptured counts are zero and the graded section is absent.

- [ ] **Step 11: Add `uncapturedMarkdown` above the exported builder and replace the builder.**

```js
function uncapturedMarkdown(skipped, notCaptured) {
  const lines = skipped.map(({ tab, kind, error }) => {
    if (kind === "blocked") {
      return `- Blocked by your site permission: ${safeContextText(new URL(tab.url).hostname, Infinity)}`;
    }
    return `- Could not read: ${safeContextText(tab.title || "Untitled", Infinity)} — ${safeContextText(safeContextUrl(tab.url), Infinity)} — ${safeContextText(error, Infinity)}`;
  });
  for (const tab of notCaptured.overLimit) {
    lines.push(`- Over the 8-tab limit: ${safeContextText(tab.title || "Untitled", Infinity)} — ${safeContextText(safeContextUrl(tab.url), Infinity)}`);
  }
  if (notCaptured.nonWeb) lines.push(`- Non-web tabs not captured: ${notCaptured.nonWeb}`);
  return lines.length ? `\n## Skipped and not captured\n${lines.join("\n")}` : "";
}

export function buildResearchTrail({ question = "", captures = [], skipped = [], notCaptured = { overLimit: [], nonWeb: 0 } }) {
  const safeQuestion = safeContextText(question, Infinity);
  const title = safeQuestion ? `Research Trail: ${safeQuestion}` : "Browser research trail";
  const counts = {
    captured: captures.length,
    skipped: skipped.length,
    notCaptured: notCaptured.overLimit.length + notCaptured.nonWeb
  };
  const collected = captures.length ? `collected: ${safeContextText(captures[0].capturedAt, Infinity)} · ` : "";
  const content = [
    `# ${title}`,
    `- research question: ${safeQuestion || "none given"}`,
    `- ${collected}sources captured: ${counts.captured} · skipped: ${counts.skipped} · not captured: ${counts.notCaptured}`,
    captures.length ? `\n## Sources\n${captures.map(sourceMarkdown).join("\n\n")}` : "",
    uncapturedMarkdown(skipped, notCaptured),
    "\n## Review\nRaw source material, queued for review. Nothing was written to trusted memory."
  ].filter(Boolean).join("\n");
  return { title, content, counts };
}
```

- [ ] **Step 12: Run the builder tests.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: PASS.

- [ ] **Step 13: Add the failing title-length contract.** Append:

```js
test("trail keeps the scrubbed question as typed and shortens only its title component", () => {
  const question = `Compare  sources: ${"a".repeat(100)}`;
  const result = buildResearchTrail(input({ question }));
  assert.equal(result.title, `Research Trail: ${question.slice(0, 80)}`);
  assert.ok(result.content.includes(`- research question: ${question}\n`));
  const whitespace = buildResearchTrail(input({ question: "  Compare   these  sources  " }));
  assert.ok(whitespace.content.includes("- research question: Compare  these  sources\n"));
});


```

- [ ] **Step 14: Run the red test.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: FAIL, returned long title differs from the 80-character question component. Empty-content assertions were introduced before the module existed; Step 18 also mutation-checks the fallback title.

- [ ] **Step 15: Replace the builder's title declaration.**

```js
const title = safeQuestion ? `Research Trail: ${safeQuestion.slice(0, 80)}` : "Browser research trail";
```

- [ ] **Step 16: Run the builder tests.**

Run: `node --test browser-first/test/research-trail.test.mjs`
Expected: PASS.

- [ ] **Step 17: Record the moved formatting ownership.** Insert exactly this row immediately after the browser-page-actions ownership row:

```markdown
| `browser-first/resonantos-side-panel-extension/src/lib/research-trail.js` | Deterministic research-trail intake formatting and graded skipped-tab disclosure | Caller-supplied snapshots, capture times, skipped-tab classifications, and chat context scrubbers | Returned title, Markdown content, and counts only | Browser reads, clocks, network calls, provider synthesis, archive writes, or promotion |
```

- [ ] **Step 18: Prove red sensitivity for privacy and existing branches, one temporary mutation at a time.** Use these exact single-line replacements in `research-trail.js`; run `node --test browser-first/test/research-trail.test.mjs` after each replacement and expect FAIL. Restore the original line immediately after each failure. Do not commit a mutant. These are test-validation mutations, not product changes.

| Original line | Temporary replacement | Expected failing assertion |
| --- | --- | --- |
| `const text = safeContextText(snapshot.text, Infinity);` | `const text = String(snapshot.text ?? "");` | Bearer value absent from body/passage |
| `return \`- Blocked by your site permission: ${safeContextText(new URL(tab.url).hostname, Infinity)}\`;` | `return \`- Blocked by your site permission: ${tab.title}\`;` | Domain-only line and private-title absence |
| `const title = safeQuestion ? \`Research Trail: ${safeQuestion.slice(0, 80)}\` : "Browser research trail";` | `const title = safeQuestion ? \`Research Trail: ${safeQuestion.slice(0, 80)}\` : "";` | Empty-question title |

- [ ] **Step 19: Verify the independent deliverable.**

Run individually:

```bash
node --test browser-first/test/research-trail.test.mjs
node --test --test-concurrency=1 scripts/module-ownership-doc.test.mjs
npm run docs:check
npm run test:docs
```

Expected: all exit 0; no mutation remains. New tests discovered automatically by the existing runner.

- [ ] **Step 20: Commit Task 1.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/research-trail.js browser-first/test/research-trail.test.mjs docs/architecture/MODULE-OWNERSHIP.md
git commit -m "feat(extension): build deterministic research trail intake (#227)"
```

### Task 2: Wire capture provenance and the two-route archive handoff

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js` (imports; factory dependencies around line 111; old formatter around line 837; save function around line 963)
- Modify/Test: `browser-first/test/browser-page-actions.test.mjs` (`createHarness`; existing trail tests around lines 732 and 783)

**Interfaces:**
- Consumes: `buildResearchTrail({ question: string, captures: Array<{ snapshot, capturedAt: string }>, skipped: Array<{ tab, kind: 'failed' | 'blocked', error: string }>, notCaptured: { overLimit: Array<tab>, nonWeb: number } }): { title: string, content: string, counts: { captured: number, skipped: number, notCaptured: number } }` from Task 1.
- Consumes: `deps.now?: () => Date`, existing `readSpecificTabPage(tab): Promise<{ ok: boolean, tab, snapshot?, error?: string }>`, and late-bound `bridge()`.
- Produces: unchanged callable `saveResearchTrailToArchive(rawText = '')`; success resolves `{ ...intakeResult, ok: true, reviewRequestPath: string, reviewQueued: true, pages: number, skipped: number, notCaptured: number }`. Task 3 completes failure behavior.
- Uses `/archive/intake` POST `{ title, url, origin: 'browser-research-trail', content }`, then `/archive/review/request` POST `{ path: intakeResult.path, reason }`. No new host contract, model call, memory route, or promotion call.

**Deliverable:** Successful saves use the builder, per-read timestamps, and exactly the two approved routes. Existing no-readable behavior remains intact until Task 3 adds counts/handling.

- [ ] **Step 1: Make the existing multi-tab test demand the new contract.** Replace the whole existing `browser page actions save multi-tab research trail to reviewed intake` test with:

```js
test("browser page actions save multi-tab research trail to reviewed intake", async () => {
  const times = ["2026-10-07T14:00:00.000Z", "2026-10-07T14:00:01.000Z"];
  let clockCalls = 0;
  const harness = createHarness({
    controlledTabId: 1,
    now: () => new Date(times[clockCalls++]),
    lastSnapshot: { title: "Stale", url: "https://stale.test/", text: "cached stale content" },
    tabs: [
      { id: 1, active: true, title: "Alpha", url: "https://alpha.test/?token=query-value#part" },
      { id: 2, active: false, title: "Beta", url: "https://beta.test/" },
      { id: 3, active: false, title: "Private extension title", url: "chrome-extension://abc/private-panel.html" }
    ],
    sendMessage: (_call, message, _options, tabId) => {
      assert.equal(message.type, "read_page");
      return {
        ok: true,
        snapshot: {
          title: tabId === 1 ? "Alpha" : "Beta",
          url: tabId === 1 ? "https://alpha.test/?token=query-value#part" : "https://beta.test/",
          text: tabId === 1 ? "Alpha research source text." : "Beta research source text.",
          links: [{ text: "Source", href: `https://${tabId === 1 ? "alpha" : "beta"}.test/source` }],
          controls: [], fields: [], frame: { isTop: true }
        }
      };
    },
    bridgeRequest: async (route) => route === "/archive/intake"
      ? { path: "INTAKE/browser/research-trail.md", bytes: 300 }
      : { path: "REVIEW/requests/research-trail.md", status: "pending" }
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail ResonantOS market research");
  assert.equal(result.ok, true);
  assert.equal(result.pages, 2);
  assert.equal(result.skipped, 0);
  assert.equal(result.notCaptured, 1);
  assert.equal(result.reviewQueued, true);
  assert.equal(result.path, "INTAKE/browser/research-trail.md");
  assert.equal(result.reviewRequestPath, "REVIEW/requests/research-trail.md");
  assert.equal(clockCalls, 2);
  assert.equal(harness.events.filter((event) => event[0] === "sendMessage" && event[1] === "read_page").length, 2);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const intake = calls[0][2];
  assert.equal(intake.method, "POST");
  assert.equal(intake.body.origin, "browser-research-trail");
  assert.equal(intake.body.title, "Research Trail: ResonantOS market research");
  assert.equal(intake.body.url, "https://alpha.test/");
  assert.match(intake.body.content, /- research question: ResonantOS market research/);
  assert.match(intake.body.content, /### 1\. Alpha/);
  assert.match(intake.body.content, /### 2\. Beta/);
  for (const time of times) assert.ok(intake.body.content.includes(`- captured at: ${time}`));
  assert.match(intake.body.content, /- Non-web tabs not captured: 1/);
  assert.doesNotMatch(intake.body.content, /Stale|cached stale content|query-value|Private extension title|private-panel/);
  assert.ok(intake.body.content.endsWith("Raw source material, queued for review. Nothing was written to trusted memory."));
  assert.equal(calls[1][2].method, "POST");
  assert.equal(calls[1][2].body.path, result.path);
  assert.match(calls[1][2].body.reason, /multi-page browser research trail/);
  assert.ok(harness.events.some((event) => event[0] === "message" &&
    event[2].includes("Saved a 2-page trail; 0 tabs skipped") &&
    event[2].includes(result.path) && event[2].includes("queued for review") &&
    event[2].includes("Next: open Living Archive > Review Queue")));
});
```

- [ ] **Step 2: Run the red orchestrator test.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL in the updated trail test (missing `notCaptured`, `reviewQueued`, injected clock and new layout); other tests retain their prior behavior.

- [ ] **Step 3: Add the import and clock dependency, and extend only the existing harness.**

Add to the imports in `browser-page-actions.js`:

```js
import { buildResearchTrail } from "./research-trail.js";
```

Add this property in the factory's dependency destructuring after `normalizeBrowserUrl`:

```js
now = () => new Date(),
```

Add this property to the `createBrowserPageActions({ ... })` object inside the existing `createHarness` after `normalizeBrowserUrl`:

```js
now: overrides.now,
```

The default handles `undefined`; no change to side-panel composition is needed.

- [ ] **Step 4: Remove the old formatter.** Delete exactly the entire `researchTrailIntakeMarkdown` function declaration, from its signature to its closing brace immediately before `async function summarizeCurrentPageToArchive`. Use this executable, bounded edit to avoid deleting adjacent code:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path('browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js')
s = p.read_text()
start = s.index('  function researchTrailIntakeMarkdown(')
end = s.index('  async function summarizeCurrentPageToArchive(', start)
p.write_text(s[:start] + s[end:])
PY
```

- [ ] **Step 5: Replace the existing save function with the complete success-path orchestrator.** Preserve the neighboring functions unchanged.

```js
async function saveResearchTrailToArchive(rawText = "") {
  const question = String(rawText ?? "").replace(/^(?:research trail|trail|research)\b\s*/i, "").trim();
  const label = safeContextText(question, 80) || "Browser research trail";
  setActivity("retrieving", "Collecting browser research trail", label);
  setStatus("Collecting trail");
  const allTabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
  const readable = allTabs.filter(isReadableBrowserTab);
  const tabs = readable.slice(0, 8);
  const notCaptured = { overLimit: readable.slice(8), nonWeb: allTabs.length - readable.length };
  if (!tabs.length) {
    await addMessage("system", "No readable browser tabs are available for a research trail. Open one or more normal web pages first.");
    setStatus("Trail unavailable");
    setActivity("failed", "No readable tabs", "Research trail");
    return { ok: false, error: "No readable browser tabs available." };
  }
  const captures = [];
  const skipped = [];
  for (const tab of tabs) {
    const capturedAt = now().toISOString();
    const read = await readSpecificTabPage(tab);
    if (read.ok && read.snapshot) {
      captures.push({ snapshot: read.snapshot, capturedAt });
    } else {
      const error = read.error || "No readable page context returned.";
      const kind = /^Assistant is blocked on /i.test(error) || /^Site permissions could not be read/i.test(error)
        ? "blocked" : "failed";
      skipped.push({ tab, kind, error });
    }
  }
  if (!captures.length) {
    await addMessage("system", "I could not read any open web tabs for the research trail. Check site permissions or open readable pages.");
    setStatus("Trail unavailable");
    setActivity("failed", "No readable tab content", "Research trail");
    return { ok: false, error: "No readable tab content available.", skipped };
  }
  const trail = buildResearchTrail({ question, captures, skipped, notCaptured });
  const result = await bridge()("/archive/intake", {
    method: "POST",
    body: {
      title: trail.title,
      url: safeContextText(safeContextUrl(captures[0].snapshot.url), Infinity) || null,
      origin: "browser-research-trail",
      content: trail.content
    }
  });
  const review = await bridge()("/archive/review/request", {
    method: "POST",
    body: {
      path: result.path,
      reason: "Evaluate this multi-page browser research trail for Living Archive ingestion, source provenance, entity extraction, contradictions, and durable wiki synthesis."
    }
  });
  await addMessage("system", `Saved a ${trail.counts.captured}-page trail; ${trail.counts.skipped} tabs skipped\n\n${result.path}\n\nRaw source material, queued for review. Nothing was written to trusted memory.\n\n${reviewQueueGuidance}`);
  setStatus("Research trail saved");
  setActivity("completed", "Saved research trail intake", result.path);
  return { ...result, ok: true, reviewRequestPath: review.path, reviewQueued: true, pages: trail.counts.captured, skipped: trail.counts.skipped, notCaptured: trail.counts.notCaptured };
}
```

- [ ] **Step 6: Run the updated orchestrator tests.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS, including both old tests; Task 3 intentionally remains responsible for error branches.

- [ ] **Step 7: Strengthen the second existing trail test.** Replace `browser page actions report when research trail has no readable tabs` with this test, preserving it as the named no-readable failure row:

```js
test("browser page actions report when research trail has no readable tabs", async () => {
  let clockCalls = 0;
  const harness = createHarness({
    now: () => { clockCalls += 1; return new Date("2026-10-07T14:00:00.000Z"); },
    tabs: [{ id: 1, active: true, title: "Extension", url: "chrome-extension://abc/panel.html" }]
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail");
  assert.equal(result.ok, false);
  assert.equal(result.error, "No readable browser tabs available.");
  assert.equal(clockCalls, 0);
  assert.equal(harness.events.some((event) => event[0] === "sendMessage"), false);
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), []);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    "No readable browser tabs are available for a research trail. Open one or more normal web pages first."));
});
```

This unchanged product behavior is mutation-validated red-first as failure row 1 in Task 3; do not claim it is newly implemented here.

- [ ] **Step 8: Validate the exact-route assertion with a temporary extra route.** Insert the following single line immediately after the intake call and before the review call, run the focused tests expecting FAIL with three routes instead of two, then remove exactly this line:

```js
await bridge()("/archive/review/queue", { method: "GET" });
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected with mutation: FAIL at the full route-array equality. Expected after removal: PASS. This read-only mutation proves an extra call cannot evade the assertion; never invoke a real promote/memory write to test the boundary.

- [ ] **Step 9: Verify the combined deliverable.**

```bash
node --test browser-first/test/research-trail.test.mjs
node --test browser-first/test/browser-page-actions.test.mjs
```

Expected: both exit 0. Review diff: no old formatter; only one clock call per attempted tab; blocked/refused reads classified; extra route removed.

- [ ] **Step 10: Commit Task 2.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js browser-first/test/browser-page-actions.test.mjs
git commit -m "feat(extension): hand research trails to archive review (#227)"
```

### Task 3: Failure handling, one red-first cycle per design-table row

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js` (only `saveResearchTrailToArchive`)
- Modify/Test: `browser-first/test/browser-page-actions.test.mjs` (existing harness, no second harness)

**Interfaces:**
- Consumes: Task 1 builder and Task 2 clock-injected capture loop and archive handoff, unchanged parameter shapes.
- Produces: intake failure `{ ok: false, error: string }`; review failure `{ ...intakeResult, ok: true, reviewQueued: false, pages: number, skipped: number, notCaptured: number }`; normal success retains Task 2 result. No capture returns `ok: false`; every-read failure exposes `skipped` as before and reports counts in the message.
- Test-local constants below are only test inputs, not a replacement harness. Each test calls the existing `createHarness`, whose bridge wrapper records routes before an override can throw.

**Deliverable:** Every failure-handling row has a dedicated test, the saved path survives a review-queue failure, and failures never imply an unsaved artifact is queued.

The no-readable, partial-read, unreadable-permission, over-limit and empty-question paths already exist wholly or partly after Task 2. For those rows, the specified temporary mutation makes the test's **first validation run red**, then restoring the correct implementation makes it green. This is explicit regression-test validation, not a claim those features were absent. The all-failed, intake-error and review-error rows use ordinary missing-behavior red/green cycles. Never commit mutations.

- [ ] **Step 1: Add reusable test input constants before the trail tests.**

```js
const trailTime = "2026-10-07T14:00:00.000Z";
const trailSavedPath = "INTAKE/browser/research-trail.md";
const trailReviewPath = "REVIEW/requests/research-trail.md";
const trailArchiveResponse = async (route) => route === "/archive/intake"
  ? { path: trailSavedPath, bytes: 300 }
  : { path: trailReviewPath, status: "pending" };
```

- [ ] **Step 2: Row 1 (no readable tabs), make the existing test red.** In the no-tabs branch only, temporarily replace this return:

```js
return { ok: false, error: "No readable browser tabs available." };
```

with:

```js
return { ok: true, error: "No readable browser tabs available." };
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL in the updated no-readable-tabs test on `ok`.

- [ ] **Step 3: Restore the no-readable return and run green.**

```js
return { ok: false, error: "No readable browser tabs available." };
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS; no clock/read/bridge call occurred in the no-readable row.

- [ ] **Step 4: Row 2 (every read fails), add the red test.** Append:

```js
test("research trail every read fails with counts by reason and no archive calls", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Blocked private", url: "https://blocked.test/private" },
      { id: 2, title: "Unknown private", url: "https://unknown.test/private" },
      { id: 3, title: "Failed", url: "https://failed.test/" },
      { id: 4, title: "Non-web private", url: "chrome://settings/" }
    ],
    permissionForUrl: async (url) => {
      if (url.includes("blocked.test")) return "blocked";
      if (url.includes("unknown.test")) throw new Error("storage unavailable");
      return "ask-before-action";
    },
    sendMessage: () => ({ ok: false, error: "frame unavailable" })
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail evidence");
  assert.equal(result.ok, false);
  assert.deepEqual(result.skipped.map((item) => item.kind), ["blocked", "blocked", "failed"]);
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), []);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    "No readable browser tabs are available for a research trail. Open one or more normal web pages first.\n\nBlocked: 2; failed: 1; over the 8-tab limit: 0; non-web: 1."));
});
```

- [ ] **Step 5: Run row 2 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL, old all-read-failed message lacks the required counts.

- [ ] **Step 6: Replace only the `if (!captures.length)` block.**

```js
if (!captures.length) {
  const blocked = skipped.filter((item) => item.kind === "blocked").length;
  const failed = skipped.length - blocked;
  await addMessage("system", `No readable browser tabs are available for a research trail. Open one or more normal web pages first.\n\nBlocked: ${blocked}; failed: ${failed}; over the 8-tab limit: ${notCaptured.overLimit.length}; non-web: ${notCaptured.nonWeb}.`);
  setStatus("Trail unavailable");
  setActivity("failed", "No readable tab content", "Research trail");
  return { ok: false, error: "No readable tab content available.", skipped };
}
```

- [ ] **Step 7: Run row 2 green.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS. Unknown permission counts as blocked; failed frame reads count once despite retry.

- [ ] **Step 8: Row 3 (some reads fail), add its test and mutation.** Append:

```js
test("research trail some reads fail but a graded trail is saved and queued", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Readable", url: "https://example.test/" },
      { id: 2, title: "Failed source", url: "https://failed.test/article?token=query-value#fragment" }
    ],
    sendMessage: (_call, _message, _options, tabId) => tabId === 1
      ? { ok: true, snapshot: { title: "Readable", url: "https://example.test/", text: "source text", frame: { isTop: true } } }
      : { ok: false, error: "frame unavailable" },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail Which evidence?");
  assert.equal(result.ok, true);
  assert.equal(result.reviewQueued, true);
  assert.equal(result.pages, 1);
  assert.equal(result.skipped, 1);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.ok(calls[0][2].body.content.includes("- Could not read: Failed source — https://failed.test/article — No readable frame returned page context."));
  assert.doesNotMatch(calls[0][2].body.content, /query-value|#fragment/);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2].startsWith("Saved a 1-page trail; 1 tabs skipped\n")));
});
```

Temporarily replace `skipped.push({ tab, kind, error });` with the following complete mutation:

```js
skipped.push({ tab, kind: "blocked", error });
```

- [ ] **Step 9: Run row 3 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL, failed source becomes domain-only rather than the failed-read line (row 2 also detects the wrong kind).

- [ ] **Step 10: Restore the classifier output and run green.**

```js
skipped.push({ tab, kind, error });
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS.

- [ ] **Step 11: Row 4 (site permission unreadable), add its test and mutation.** Append:

```js
test("research trail treats unreadable site permission as blocked and never reads that tab", async () => {
  const attemptedTabs = [];
  const harness = createHarness({
    now: () => new Date(trailTime),
    tabs: [
      { id: 1, title: "Readable", url: "https://example.test/" },
      { id: 2, title: "Unknown secret title", url: "https://unknown.test/private-unknown?token=query-value" },
      { id: 3, title: "Blocked secret title", url: "https://blocked.test/private-blocked" }
    ],
    permissionForUrl: async (url) => {
      if (url.includes("unknown.test")) throw new Error("storage unavailable");
      return url.includes("blocked.test") ? "blocked" : "ask-before-action";
    },
    sendMessage: (_call, _message, _options, tabId) => {
      attemptedTabs.push(tabId);
      return { ok: true, snapshot: { title: "Readable", url: "https://example.test/", text: "source text", frame: { isTop: true } } };
    },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail permissions");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 2);
  assert.deepEqual(attemptedTabs, [1]);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const content = calls[0][2].body.content;
  assert.ok(content.includes("- Blocked by your site permission: unknown.test"));
  assert.ok(content.includes("- Blocked by your site permission: blocked.test"));
  assert.doesNotMatch(content, /Unknown secret title|Blocked secret title|private-unknown|private-blocked|query-value|capture refused/);
});
```

Temporarily replace the classifier's declaration with:

```js
const kind = /^Assistant is blocked on /i.test(error) ? "blocked" : "failed";
```

- [ ] **Step 12: Run row 4 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL, unknown-permission title/path leaks into the failed grade.

- [ ] **Step 13: Restore the complete refusal classification and run green.**

```js
const kind = /^Assistant is blocked on /i.test(error) || /^Site permissions could not be read/i.test(error)
  ? "blocked" : "failed";
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS.

- [ ] **Step 14: Row 5 (more than eight readable tabs), add its test and mutation.** Append:

```js
test("research trail captures only eight readable tabs and lists every over-limit tab", async () => {
  const attemptedTabs = [];
  let clockCalls = 0;
  const tabs = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, title: `Source ${i + 1}`, url: `https://source${i + 1}.test/article?token=query-value#fragment`
  }));
  const harness = createHarness({
    tabs: [{ id: 99, title: "Private non-web", url: "chrome://settings/private" }, ...tabs],
    now: () => { clockCalls += 1; return new Date(trailTime); },
    sendMessage: (_call, _message, _options, tabId) => {
      attemptedTabs.push(tabId);
      return { ok: true, snapshot: { ...tabs[tabId - 1], text: "source text", frame: { isTop: true } } };
    },
    bridgeRequest: trailArchiveResponse
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail coverage");
  assert.equal(result.ok, true);
  assert.equal(result.pages, 8);
  assert.equal(result.skipped, 0);
  assert.equal(result.notCaptured, 3);
  assert.equal(clockCalls, 8);
  assert.deepEqual(attemptedTabs, [1, 2, 3, 4, 5, 6, 7, 8]);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  const content = calls[0][2].body.content;
  assert.ok(content.includes("sources captured: 8 · skipped: 0 · not captured: 3"));
  assert.ok(content.includes("- Over the 8-tab limit: Source 9 — https://source9.test/article"));
  assert.ok(content.includes("- Over the 8-tab limit: Source 10 — https://source10.test/article"));
  assert.ok(content.includes("- Non-web tabs not captured: 1"));
  assert.doesNotMatch(content, /Private non-web|settings\/private|query-value|#fragment/);
});
```

Temporarily replace the `notCaptured` declaration with:

```js
const notCaptured = { overLimit: [], nonWeb: allTabs.length - readable.length };
```

- [ ] **Step 15: Run row 5 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL, over-limit count/list absent.

- [ ] **Step 16: Restore over-limit collection and run green.**

```js
const notCaptured = { overLimit: readable.slice(8), nonWeb: allTabs.length - readable.length };
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS; non-web tabs do not consume the eight readable slots.

- [ ] **Step 17: Row 6 (intake throws), add the red test.** Append:

```js
test("research trail intake failure reports nothing saved and never requests review", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    bridgeRequest: async () => { throw new Error("disk unavailable"); }
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail evidence");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not save the research trail: disk unavailable. Nothing was saved.");
  assert.equal(result.path, undefined);
  assert.deepEqual(harness.events.filter((event) => event[0] === "bridge").map((event) => event[1]), ["/archive/intake"]);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] === result.error));
});
```

- [ ] **Step 18: Run row 6 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL with uncaught `disk unavailable`.

- [ ] **Step 19: Replace the intake declaration/call with this guarded block.** Only the save function's call changes; other archive features remain unchanged.

```js
let result;
try {
  result = await bridge()("/archive/intake", {
    method: "POST",
    body: {
      title: trail.title,
      url: safeContextText(safeContextUrl(captures[0].snapshot.url), Infinity) || null,
      origin: "browser-research-trail",
      content: trail.content
    }
  });
} catch (error) {
  const reason = safeContextText(error instanceof Error ? error.message : String(error));
  const message = `Could not save the research trail: ${reason}. Nothing was saved.`;
  await addMessage("system", message);
  setStatus("Trail unavailable");
  setActivity("failed", "Could not save the research trail", reason);
  return { ok: false, error: message };
}
```

- [ ] **Step 20: Run row 6 green.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS, only the intake route was called on this failure.

- [ ] **Step 21: Row 7 (review request throws), add the red test.** Append:

```js
test("research trail review failure preserves saved path and returns reviewQueued false", async () => {
  const harness = createHarness({
    now: () => new Date(trailTime),
    bridgeRequest: async (route) => {
      if (route === "/archive/intake") return { path: trailSavedPath, bytes: 300 };
      throw new Error("review unavailable");
    }
  });
  const result = await harness.actions.saveResearchTrailToArchive("trail evidence");
  assert.equal(result.ok, true);
  assert.equal(result.path, trailSavedPath);
  assert.equal(result.reviewQueued, false);
  assert.equal(result.reviewRequestPath, undefined);
  assert.equal(result.pages, 1);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.equal(calls[1][2].body.path, trailSavedPath);
  assert.ok(harness.events.some((event) => event[0] === "message" && event[2] ===
    `Saved to ${trailSavedPath}, but it could not be queued for review; ask again with `/trail` or queue it from the archive.`));
  assert.equal(harness.events.some((event) => event[0] === "message" && event[2].includes("Nothing was saved.")), false);
});
```

- [ ] **Step 22: Run row 7 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL with uncaught `review unavailable`, after successful intake.

- [ ] **Step 23: Replace the review declaration/call with this guarded block.**

```js
let review;
try {
  review = await bridge()("/archive/review/request", {
    method: "POST",
    body: {
      path: result.path,
      reason: "Evaluate this multi-page browser research trail for Living Archive ingestion, source provenance, entity extraction, contradictions, and durable wiki synthesis."
    }
  });
} catch {
  await addMessage("system", `Saved to ${result.path}, but it could not be queued for review; ask again with `/trail` or queue it from the archive.`);
  setStatus("Research trail saved");
  setActivity("completed", "Saved research trail intake", result.path);
  return { ...result, ok: true, reviewQueued: false, pages: trail.counts.captured, skipped: trail.counts.skipped, notCaptured: trail.counts.notCaptured };
}
```

- [ ] **Step 24: Run row 7 green.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS; never retry intake or promote following review failure.

- [ ] **Step 25: Row 8 (`/trail` with no text), add its test and mutation.** Append:

```js
test("research trail without question saves Browser research trail with none given", async () => {
  const harness = createHarness({ now: () => new Date(trailTime), bridgeRequest: trailArchiveResponse });
  // The router turns '/trail' into saveIntake('trail'), which calls this action.
  const result = await harness.actions.saveResearchTrailToArchive("trail");
  assert.equal(result.ok, true);
  assert.equal(result.reviewQueued, true);
  const calls = harness.events.filter((event) => event[0] === "bridge");
  assert.deepEqual(calls.map((event) => event[1]), ["/archive/intake", "/archive/review/request"]);
  assert.equal(calls[0][2].body.title, "Browser research trail");
  assert.ok(calls[0][2].body.content.startsWith("# Browser research trail\n- research question: none given\n"));
});
```

Temporarily replace the builder invocation in the orchestrator with:

```js
const trail = buildResearchTrail({ question: question || "trail", captures, skipped, notCaptured });
```

- [ ] **Step 26: Run row 8 red.**

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: FAIL, empty command incorrectly records `trail` as its question/title.

- [ ] **Step 27: Restore the builder input and run green.**

```js
const trail = buildResearchTrail({ question, captures, skipped, notCaptured });
```

Run: `node --test browser-first/test/browser-page-actions.test.mjs`
Expected: PASS.

- [ ] **Step 28: Verify the failure deliverable.**

```bash
node --test browser-first/test/research-trail.test.mjs
node --test browser-first/test/browser-page-actions.test.mjs
```

Expected: both exit 0; the table's eight rows each have a named test. Check that temporary mutations from each cycle were restored, reads still use real harness injection, and all bridge assertions inspect the full route list.

- [ ] **Step 29: Commit Task 3.**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js browser-first/test/browser-page-actions.test.mjs
git commit -m "fix(extension): report research trail save and review failures (#227)"
```

### Task 4: Live CI-profile proof and release gates

**Files:**
- Modify: `browser-first/test/agent-control-live.mjs` (common slash-command sequence immediately before `/capabilities`, currently around line 1200)
- Read/verify only: `scripts/browser-first-release-scope-audit.mjs` (`classify` includes the entire `browser-first/` subtree)
- No release allowlist or workflow edit required at this baseline.

**Interfaces:**
- Consumes: existing `submitControlCommand(panel, command)` (uses `evaluate` to set `#command-input`, dispatch `input`, and submit `#command-form`); `waitForPanelText(panel, pattern, label): Promise<string>`; existing local `assert(condition, message)` and `certificationReport.record(name, status, reason)`.
- Consumes: Task 3 success feedback `Saved a N-page trail; M tabs skipped`, saved relative `INTAKE/browser/*.md` path, and `Raw source material, queued for review. Nothing was written to trusted memory.`.
- Produces: one live certification record `research-trail-save`, in both `full` and `agent-control` profiles, with visible confirmation and path.

**Deliverable:** The real command is proven through the fixture page in the CI profile; required deterministic and strict committed-scope gates pass, or exact external blockers are recorded without claiming certification.

- [ ] **Step 1: Add the live assertion in the common sequence.** Insert this entire block after the `assert(sitePanelMode.mode, ...)` assertion and immediately before `await submitControlCommand(panel, \`/capabilities\`);`. This is after the full-only branch, after fail-closed proof restores the fixture permission, and before `/site block`. The existing fixture activation via `evaluate` has already run.

```js
  await submitControlCommand(panel, "/trail Live fixture research");
  const trailPanelText = await waitForPanelText(
    panel,
    /Saved a \d+-page trail; \d+ tabs skipped[\s\S]*INTAKE\/browser\/[^\s]+\.md[\s\S]*Raw source material, queued for review\. Nothing was written to trusted memory\./,
    "research trail save and review handoff"
  );
  const trailSavedPath = trailPanelText.match(/INTAKE\/browser\/[^\s]*research-trail-live-fixture-research\.md/);
  assert(trailSavedPath, "Research trail confirmation did not include its saved intake path.");
  certificationReport.record(
    "research-trail-save",
    "passed",
    "Fixture /trail command displayed the saved intake path and review-queued confirmation."
  );
```

The slug is grounded in `executeArchiveIntake` in `browser-first/host/archive-review-service.mjs` and `safeFileSlug` in `browser-first/host/browser-first-host-utils.mjs`; timestamps vary and are not hardcoded. This step sends no model prompt and does not request promotion.

- [ ] **Step 2: Make the new live proof fail first by temporarily hiding the success path.** In the trail success `addMessage` call only, temporarily replace its complete call with:

```js
await addMessage("system", `Saved a ${trail.counts.captured}-page trail; ${trail.counts.skipped} tabs skipped\n\nRaw source material, queued for review. Nothing was written to trusted memory.\n\n${reviewQueueGuidance}`);
```

Run locally with installed Chrome/Chromium and a graphical display:

```bash
RESONANTOS_LIVE_PROFILE=agent-control npm run test:browser-first:live
```

Expected: FAIL/time out at `research trail save and review handoff`, because the saved path is not visible. This validates the new live assertion against the specific missing-path regression rather than relying on a preexisting transcript. Each live run clears the transcript at startup. In Linux CI use the existing display wrapper:

```bash
CI=true RESONANTOS_LIVE_PROFILE=agent-control xvfb-run -a npm run test:browser-first:live
```

Use one environment-appropriate command, not both. If Chrome/display/loopback is unavailable, record that prerequisite failure and leave the live-proof checkbox open; it is not a red test of product behavior or passing certification. Always restore the mutation before proceeding.

- [ ] **Step 3: Restore visible path feedback.**

```js
await addMessage("system", `Saved a ${trail.counts.captured}-page trail; ${trail.counts.skipped} tabs skipped\n\n${result.path}\n\nRaw source material, queued for review. Nothing was written to trusted memory.\n\n${reviewQueueGuidance}`);
```

This restores Task 3 source byte-for-byte; Task 4 commits only the live-lane file.

- [ ] **Step 4: Run the live proof green in the CI profile.**

Run: `RESONANTOS_LIVE_PROFILE=agent-control npm run test:browser-first:live` locally, or the CI command from Step 2 under Xvfb.
Expected: exit 0, certification includes `research-trail-save: passed`, visible saved-path and queued confirmation. Keep generated credentials, profiles, screenshots and reports out of commits. Existing live harness controls report destinations and process cleanup.

- [ ] **Step 5: Verify the exact release-scope classification without editing the audit.**

```bash
node --input-type=module - <<'JS'
import assert from "node:assert/strict";
import { classify } from "./scripts/browser-first-release-scope-audit.mjs";
for (const file of [
  "browser-first/resonantos-side-panel-extension/src/lib/research-trail.js",
  "browser-first/test/research-trail.test.mjs"
]) {
  assert.equal(classify(file, "added").bucket, "include");
}
console.log("Both new research-trail files are allowed by the browser-first release scope.");
JS
```

Expected: that exact confirmation and exit 0. The audit's existing prefix rule is the allowlist; do not add redundant entries or weaken strict mode.

- [ ] **Step 6: Run the complete browser-first gate.**

Run: `npm run test:browser-first`
Expected: exit 0, includes the new builder and orchestrator tests. Record actual results, not an invented test count.

- [ ] **Step 7: Run the security gate.**

Run: `node scripts/security-pipeline/run-check.mjs`
Expected: exit 0. Do not weaken privacy tests or add credential-shaped fixture exemptions.

- [ ] **Step 8: Run hygiene.**

Run: `npm run repo:hygiene`
Expected: exit 0. Synthetic bearer values are `bearer-token-value-0123456789`; no literal provider-key-shaped strings are needed.

- [ ] **Step 9: Run documentation validation.**

Run: `npm run docs:check`
Expected: exit 0, including the plan/spec link and ownership map. Preserve preexisting planning changes.

- [ ] **Step 10: Run documentation tests.**

Run: `npm run test:docs`
Expected: exit 0.

- [ ] **Step 11: Commit the independent live-proof deliverable.**

```bash
git add browser-first/test/agent-control-live.mjs
git commit -m "test(extension): prove research trail save in live CI lane (#227)"
```

Check `git status --short` first; source mutations must be fully restored, and no generated config or live evidence may be staged. The committed-scope gate must run after this commit so it includes every task.

- [ ] **Step 12: Run the exact strict committed release-scope gate.**

```bash
node scripts/browser-first-release-scope-audit.mjs --committed --strict --base=origin/dev --head=HEAD
```

Expected: exit 0, no deferred/review/missing/large blockers. If `origin/dev` is unavailable, fetch that ref through the normal repository workflow and rerun the same command; do not silently substitute the base or claim the working-tree audit certifies committed changes.

- [ ] **Step 13: Run the repository-required final Alpha verification.** The ownership transfer/security/release impact makes this AGENTS-required final certification, not additional product scope.

Run: `npm run verify:alpha`
Expected: exit 0. This includes `npm run pre-release:scan` and broader deterministic checks under `scripts/verify-alpha.mjs`. The explicit commands above remain individually recorded as requested. Do not rerun them separately after this unless a new change or failure warrants it. Report unrelated baseline failures precisely; never fix outside assigned scope merely to get a green report.

## Completed planning self-review

### Spec coverage

| Approved requirement | Concrete coverage |
| --- | --- |
| `/trail` remainder is the research question, including no text | Task 2 command parsing and recorded question; Task 3 row 8; Task 4 actual router path |
| No model at save; deterministic digest, no headings extraction | Task 1 source formatter; Task 2 full route-array equality |
| Per-source address/time/word count/link count/first 60 words | Task 1 Steps 1–8; Task 2 injected-clock test |
| Text capped to first 6,000 characters | Task 1 cap test and final `sourceMarkdown` |
| Scrub question, titles, page text, link text, links, addresses and failed reasons | Task 1 privacy tests and imported scrubbers; Task 2 intake metadata URL |
| Long question preserved after required scrubbing; 80-character title question; none given | Task 1 Steps 13–16; Task 3 row 8 |
| Failed reads keep title/address/reason; blocked and unknown keep hostname/reason only | Task 1 graded test; Task 3 rows 3–4, including no attempted read for refused tabs |
| First eight readable tabs, remaining readable list, non-web count only | Task 2 collection; Task 3 row 5 and mixed-tab tests |
| Captured/skipped/notCaptured counts; omitted empty sections | Task 1 Steps 1–4 and graded contract |
| Byte-identical output; pure module never reads clock | Task 1 equality with original and cloned inputs; explicit source only accepts timestamps |
| Exactly intake then review; saved path reference; queued result; no trusted write | Task 2 full bridge route list and extra-route mutation; Task 3 failure route lists |
| All eight failure rows | Task 3 eight dedicated red/green cycles |
| Both existing research-trail tests updated | Task 2 Steps 1 and 7 |
| Required blocked-title, scrubber-removal and extra-route mutations turn tests red | Task 1 Step 18; Task 2 Step 8 |
| Live fixture command + confirmation + saved path in CI profile | Task 4 common-path insertion, outside full-only branch |
| All requested gates and allowed new browser-first files | Task 4 Steps 5–13; existing audit prefix verified |
| No changes to promotion, content-script headings, models, sidecar or limit | File map, exact route tests, bounded implementation |

No feature requirement is dropped. The final builder and orchestrator snippets were assembled and executed entirely in memory against the real scrubbers and existing harness: all 15 specified deterministic tests passed; the blocked-title, removed-text-scrubber, and extra-bridge-route mutations each failed as required, then the restored snippets passed again. No source or test file was created or changed. This validates the plan snippets, not a shipped implementation or a completed live gate. Details not uniquely grounded in the spec are explicitly recorded under Concrete format/copy interpretations: collected time selection; reason-count suffix punctuation; literal review-failure ellipsis; retained eight displayed links. The current implementation has no new failure copy to copy beyond the unchanged no-readable message; the design is authoritative for that copy.

### Placeholder scan

Completed: no hits in the scan below. Planning checks `npm run docs:check` and `npm run test:docs` both passed (293 documentation tests). Only this plan was written; preexisting README/design changes were preserved.

Run against this file and inspect each hit:

```bash
rg -n 'T[B]D|TO[D]O|implement [l]ater|fill in [d]etails|Add appropriate error [h]andling|Write tests for the [a]bove|Similar to [T]ask' docs/planning/227-research-trail-plan.md
```

Expected: no hits (exit 1). Every source/test edit has executable code or an exact bounded edit command; no undefined helper replaces `createHarness`. Template substitutions in runtime messages are real JavaScript expressions, not omitted implementation.

### Type consistency

- Builder captures consistently use `{ snapshot, capturedAt }`; caller supplies `Date.toISOString()` strings through `deps.now: () => Date`.
- Failed reads consistently use `{ tab, kind, error }`; only `failed` and `blocked` reach the builder. Unknown permissions become `blocked` before formatting.
- `notCaptured` input is an object with `overLimit` array and numeric `nonWeb`; builder `counts.notCaptured` and successful action result `notCaptured` are numeric totals.
- Normal success has `reviewQueued: true` and `reviewRequestPath`; partial archive success has `ok: true`, saved `path`, and `reviewQueued: false` without a fabricated request path.
- Route stubs receive `(route, options)`; recorded events are indexed at `[1]` for route and `[2].body` for payload. Tests use the existing four-argument `sendMessage` override, whose fourth argument is tab ID.
- Opening passage and word count use complete scrubbed text; body is independently capped. This was checked against the cap fixture so the test does not forbid text legitimately present in the first 60 words.
- Plain ES modules throughout. No TypeScript declarations in runtime `.js`, no new dependencies, no new scrubber, no wall clock in the builder.

Execution is deliberately not started: this request authorizes a plan only. When implementation is requested, the skill's two execution options are subagent-driven task execution (recommended) or inline execution using executing-plans; either follows these four commit boundaries.
