# Augmentor Page-Understanding Fixture Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable article/PDF/media page snapshots and explicit skip-reason surfacing in Augmentor page context, with tests for both happy and skipped-content paths.

**Architecture:** Extend `pageContextForSnapshot` in `chat-turn-controller.js` to emit a `Skipped content:` line when the snapshot has a `skipReason` field or when readable text is absent. Add a pure-data fixture module so the new paths can be tested without a browser. Update the background sanitizer to pass `skipReason` through unchanged.

**Tech Stack:** ES modules, Node.js built-in `node:test` runner, Chrome Manifest V3 extension code (no UI framework changes).

---

## File Structure

- **Modify:** `browser-first/resonantos-side-panel-extension/src/lib/chat-turn-controller.js`
  - Responsibility: format the page context string sent to Augmentor.
- **Create:** `browser-first/test/fixtures/page-snapshots.mjs`
  - Responsibility: provide reusable, redaction-safe snapshot objects for article, PDF, media, and mixed-media pages.
- **Modify:** `browser-first/test/chat-turn-controller.test.mjs`
  - Responsibility: verify fixture-based happy/skipped path formatting, redaction, and excerpt bounds.
- **Modify:** `browser-first/test/background-message-policy.test.mjs`
  - Responsibility: verify the sanitizer preserves `skipReason` and truncates long reasons.
- **Modify:** `browser-first/resonantos-side-panel-extension/src/lib/background-message-policy.js`
  - Responsibility: accept and bound a `skipReason` string on incoming snapshots.

---

## Task 1: Add `skipReason` support to the background sanitizer

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/background-message-policy.js`
- Test: `browser-first/test/background-message-policy.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `browser-first/test/background-message-policy.test.mjs` after the existing tests:

```javascript
test("background policy preserves bounded skipReason on Resonant Context snapshots", () => {
  const withReason = sanitizeResonantContextSnapshot({
    title: "PDF",
    url: "https://example.com/file.pdf",
    skipReason: "PDF viewer — text extraction is not available."
  });
  assert.equal(withReason.skipReason, "PDF viewer — text extraction is not available.");

  const withoutReason = sanitizeResonantContextSnapshot({
    title: "Page",
    url: "https://example.com/"
  });
  assert.equal(withoutReason.skipReason, null);

  const longReason = sanitizeResonantContextSnapshot({
    title: "Media",
    url: "https://example.com/video",
    skipReason: `No readable text. ${"x".repeat(400)}`
  });
  assert.equal(longReason.skipReason.length, 240);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test browser-first/test/background-message-policy.test.mjs
```

Expected: FAIL — `skipReason` is `undefined` and long reasons are not truncated.

- [ ] **Step 3: Implement `skipReason` in the sanitizer**

In `browser-first/resonantos-side-panel-extension/src/lib/background-message-policy.js`, locate the `sanitizeResonantContextSnapshot` return object (around line 200) and add a `skipReason` field after `receivedAt`:

```javascript
    skipReason: safeText(source.skipReason, 240) || null,
```

The complete return object should look like:

```javascript
  return {
    tabId,
    title: safeText(source.title || sourcePage.title || title, 160),
    url: sourceUrl,
    text: safeText(source.text ?? source.visibleText ?? sourcePage.visibleText ?? source.summary, 7000),
    v: safeText(source.v ?? source.schema, 40),
    domain: safeText(source.domain ?? source.hostname, 120),
    summary: safeText(source.summary, 1600),
    page: {
      path: safePath(sourcePage.path ?? source.path ?? sourceUrl),
      title: safeText(sourcePage.title || source.title || title, 160),
      timeOnPageMs: safeNumber(sourcePage.timeOnPageMs, 0),
      headings: safeArray(sourcePage.headings, 12, (heading) => safeText(heading, 160)),
    },
    viewport: {
      visibleSections: sections,
      activeOverlay: sourceViewport.activeOverlay ? {
        id: safeText(sourceViewport.activeOverlay.id, 100),
        type: safeText(sourceViewport.activeOverlay.type, 80),
        content: safeText(sourceViewport.activeOverlay.content, 700),
      } : null,
    },
    forms: safeArray(source.forms, 20, safeForm),
    session: {
      navigation: safeArray(sourceSession.navigation, 8, safeNavigation),
      clickTrail: safeArray(sourceSession.clickTrail, 15, safeClickTrail),
      entryPoint: safeUrl(sourceSession.entryPoint),
    },
    domain_data: safeObject(source.domain_data, 20, 0) ?? {},
    sections,
    receivedAt: new Date().toISOString(),
    skipReason: safeText(source.skipReason, 240) || null,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
node --test browser-first/test/background-message-policy.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/background-message-policy.js \
        browser-first/test/background-message-policy.test.mjs
git commit -m "feat(augmentor): preserve bounded skipReason in context sanitizer"
```

---

## Task 2: Create reusable page snapshot fixtures

**Files:**
- Create: `browser-first/test/fixtures/page-snapshots.mjs`
- Test: `browser-first/test/chat-turn-controller.test.mjs` (will import the fixtures in the next task)

- [ ] **Step 1: Create the fixture module**

Create `browser-first/test/fixtures/page-snapshots.mjs` with the following content:

```javascript
export const DEFAULT_TITLE = "Example Page";
export const DEFAULT_URL = "https://example.com/article";

export function articleSnapshot(overrides = {}) {
  return {
    title: "The Art of Resonant Context",
    url: "https://example.com/article/resonant-context",
    domain: "example.com",
    summary: "A demonstration article for Augmentor context fixtures.",
    text: [
      "ResonantOS is a browser-first operating system.",
      "It combines an authenticated local bridge with a Chrome side panel.",
      "Augmentor reads the active page and answers questions using bounded context.",
      ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ${"word ".repeat(20).trim()}.`)
    ].join("\n\n"),
    page: {
      headings: ["Introduction", "Browser-first design", "Augmentor", "Conclusion"]
    },
    viewport: {
      visibleSections: [
        { id: "intro", label: "Introduction", text: "ResonantOS is a browser-first operating system.", currentlyVisible: true, priority: 8 },
        { id: "design", label: "Browser-first design", text: "It combines an authenticated local bridge with a Chrome side panel.", currentlyVisible: true, priority: 7 }
      ],
      activeOverlay: null
    },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function pdfSnapshot(overrides = {}) {
  return {
    title: "Annual Report 2026",
    url: "https://example.com/reports/annual.pdf",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "PDF viewer — text extraction is not available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function mediaSnapshot(overrides = {}) {
  return {
    title: " keynote Livestream",
    url: "https://example.com/watch?v=keynote2026",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "Media player — no readable transcript available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function mixedMediaPageSnapshot(overrides = {}) {
  return {
    title: "Article with Embedded Video",
    url: "https://example.com/article/embedded-video",
    domain: "example.com",
    summary: "An article that contains a video but still has readable surrounding text.",
    text: "This article explains a concept. Below is an embedded player. The remaining paragraphs are readable.",
    page: { headings: ["Overview", "Demo video", "Takeaways"] },
    viewport: {
      visibleSections: [
        { id: "overview", label: "Overview", text: "This article explains a concept.", currentlyVisible: true, priority: 8 },
        { id: "video", label: "Demo video", text: "", currentlyVisible: true, priority: 5 },
        { id: "takeaways", label: "Takeaways", text: "The remaining paragraphs are readable.", currentlyVisible: true, priority: 6 }
      ],
      activeOverlay: null
    },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}

export function secretLadenSnapshot(overrides = {}) {
  return {
    title: "PDF with token in title sk_live_ABCDEFGHIJKLMNOP",
    url: "https://example.com/reports/secret.pdf?token=sk-ant-ABCDEFGHIJKLMNOP#card=4111-2222-3333-4444",
    domain: "example.com",
    summary: "",
    text: "",
    skipReason: "PDF viewer — text extraction is not available.",
    page: { headings: [] },
    viewport: { visibleSections: [], activeOverlay: null },
    forms: [],
    session: { clickTrail: [] },
    ...overrides
  };
}
```

- [ ] **Step 2: Verify the module can be imported**

Run:

```bash
node --input-type=module -e "import { articleSnapshot, pdfSnapshot, mediaSnapshot, mixedMediaPageSnapshot, secretLadenSnapshot } from './browser-first/test/fixtures/page-snapshots.mjs'; console.log('article', articleSnapshot().title); console.log('pdf', pdfSnapshot().skipReason);"
```

Expected output:

```
article The Art of Resonant Context
pdf PDF viewer — text extraction is not available.
```

- [ ] **Step 3: Commit**

```bash
git add browser-first/test/fixtures/page-snapshots.mjs
git commit -m "test(augmentor): add article, PDF, media page snapshot fixtures"
```

---

## Task 3: Surface `skipReason` and default fallback in `pageContextForSnapshot`

**Files:**
- Modify: `browser-first/resonantos-side-panel-extension/src/lib/chat-turn-controller.js`
- Test: `browser-first/test/chat-turn-controller.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to the end of `browser-first/test/chat-turn-controller.test.mjs`:

```javascript
import {
  articleSnapshot,
  mixedMediaPageSnapshot,
  pdfSnapshot,
  mediaSnapshot,
  secretLadenSnapshot
} from "./fixtures/page-snapshots.mjs";

test("pageContextForSnapshot includes title, URL, and bounded excerpt for article pages", () => {
  const context = pageContextForSnapshot(articleSnapshot());
  assert.match(context, /Title: The Art of Resonant Context/);
  assert.match(context, /URL: https:\/\/example\.com\/article\/resonant-context/);
  assert.match(context, /Visible text:\n/);
  assert.equal(context.includes("Skipped content:"), false);
  const visibleTextStart = context.indexOf("Visible text:\n");
  const visibleText = context.slice(visibleTextStart + "Visible text:\n".length);
  assert.equal(visibleText.length, 7000);
});

test("pageContextForSnapshot surfaces skip reason for PDF pages", () => {
  const context = pageContextForSnapshot(pdfSnapshot());
  assert.match(context, /Title: Annual Report 2026/);
  assert.match(context, /URL: https:\/\/example\.com\/reports\/annual\.pdf/);
  assert.match(context, /Skipped content: PDF viewer — text extraction is not available\./);
  assert.equal(context.includes("Visible text:"), false);
});

test("pageContextForSnapshot surfaces skip reason for media pages", () => {
  const context = pageContextForSnapshot(mediaSnapshot());
  assert.match(context, /URL: https:\/\/example\.com\/watch\?v=keynote2026/);
  assert.match(context, /Skipped content: Media player — no readable transcript available\./);
  assert.equal(context.includes("Visible text:"), false);
});

test("pageContextForSnapshot keeps readable text on mixed-media pages", () => {
  const context = pageContextForSnapshot(mixedMediaPageSnapshot());
  assert.match(context, /Visible text:\n/);
  assert.equal(context.includes("Skipped content:"), false);
});

test("pageContextForSnapshot adds a default skip reason when no readable text exists", () => {
  const context = pageContextForSnapshot({
    title: "Empty",
    url: "https://example.com/empty",
    text: "   "
  });
  assert.match(context, /Skipped content: page has no readable text to include as context\./);
});

test("pageContextForSnapshot still redacts secrets on skipped pages", () => {
  const context = pageContextForSnapshot(secretLadenSnapshot());
  assert.match(context, /Title: PDF with token in title \[redacted\]/);
  assert.match(context, /URL: https:\/\/example\.com\/reports\/secret\.pdf/);
  assert.equal(context.includes("sk-ant-ABCDEFGHIJKLMNOP"), false);
  assert.equal(context.includes("4111-2222-3333-4444"), false);
  assert.equal(/token=|#card=/.test(context), false);
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
node --test browser-first/test/chat-turn-controller.test.mjs
```

Expected: FAIL — the new fixture tests fail because `pageContextForSnapshot` does not handle `skipReason` or the default fallback.

- [ ] **Step 3: Implement `skipReason` and default fallback**

In `browser-first/resonantos-side-panel-extension/src/lib/chat-turn-controller.js`, replace the `pageContextForSnapshot` function body with the following implementation, preserving all existing helper functions and behavior:

```javascript
export function pageContextForSnapshot(snapshot) {
  if (!snapshot) return null;

  const text = safeContextText(snapshot.text ?? snapshot.page?.visibleText ?? "", 7000);
  const summary = safeContextText(snapshot.summary, 1600);
  const headings = Array.isArray(snapshot.page?.headings)
    ? snapshot.page.headings.slice(0, 8).map((heading) => safeContextText(heading, 120)).filter(Boolean)
    : [];

  const skipReason = safeContextText(snapshot.skipReason, 240);
  const hasReadableText = text.length > 0;
  const defaultSkipReason = !hasReadableText && snapshot.url
    ? "Skipped content: page has no readable text to include as context."
    : "";

  return [
    `Title: ${safeContextText(snapshot.title || snapshot.page?.title || "Untitled", 160)}`,
    `URL: ${safeContextUrl(snapshot.url) || "unknown"}`,
    snapshot.domain ? `Domain plugin: ${safeContextText(snapshot.domain, 120)}` : "",
    summary ? `Summary:\n${summary}` : "",
    headings.length ? `Headings:\n${headings.map((heading) => `- ${heading}`).join("\n")}` : "",
    skipReason ? `Skipped content: ${skipReason}` : defaultSkipReason,
    text ? `Visible text:\n${text}` : "",
    formatVisibleSections(snapshot),
    snapshot.viewport?.activeOverlay ? `Active overlay: ${safeContextText(snapshot.viewport.activeOverlay.content || snapshot.viewport.activeOverlay.id, 500)}` : "",
    formatForms(snapshot.forms),
    formatClickTrail(snapshot.session?.clickTrail)
  ].filter(Boolean).join("\n\n");
}
```

Key changes from the previous version:

- Computes a `skipReason` string from `snapshot.skipReason` if provided.
- Adds `defaultSkipReason` when no readable text exists and a URL is present.
- Inserts the skip-reason line after `Headings` and before `Visible text`, so it is visible even when no readable text follows.
- Keeps the same redaction, URL stripping, section/form/click formatting, and order for all other blocks.

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
node --test browser-first/test/chat-turn-controller.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add browser-first/resonantos-side-panel-extension/src/lib/chat-turn-controller.js \
        browser-first/test/chat-turn-controller.test.mjs
git commit -m "feat(augmentor): surface skip reasons for unreadable pages in context"
```

---

## Task 4: Run the full browser-first suite

**Files:**
- No file changes.

- [ ] **Step 1: Run the focused test command**

Run:

```bash
node --test browser-first/test/chat-turn-controller.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the full browser-first test suite**

Run:

```bash
npm run test:browser-first
```

Expected: PASS. If any unrelated test fails, record the exact failure and do not weaken tests or safety controls to make it pass.

- [ ] **Step 3: Run shared TypeScript/React checks**

Because `chat-turn-controller.js` is a shared library used by extension code that is bundled with the rest of the project, run:

```bash
npm test -- --run
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit any final notes**

If all checks pass, no code commit is needed. If documentation or test evidence needs updating, commit those changes separately.

---

## Task 5: Capture live extension proof (optional, if issue requires visible behavior)

**Files:**
- No file changes; this produces evidence only.

- [ ] **Step 1: Launch the bridge and load the extension**

Run:

```bash
npm run browser-first:bridge
```

Keep the terminal open. In Chrome, load the unpacked extension from `browser-first/resonantos-side-panel-extension`.

- [ ] **Step 2: Open a PDF or media page**

Open a URL such as a PDF file or a YouTube video in the active tab. Open the ResonantOS side panel.

- [ ] **Step 3: Send a test message and inspect the context**

Send a simple chat message. Use the extension's developer tools or the network panel to inspect the `/augmentor/chat` bridge request body. Assert that `pageContext` contains a `Skipped content:` line with an accurate reason and that no raw secrets are present.

- [ ] **Step 4: Save evidence**

Save a screenshot of the side panel and a redacted copy of the request payload under `ResonantOS_User/` or another local evidence directory outside the repository. Do not commit these files.

---

## Spec coverage self-review

| Spec requirement | Task that implements it |
| --- | --- |
| Page context must include title, URL, and bounded excerpt | Task 3 tests, Task 2 `articleSnapshot` |
| Skipped media must surface a clear reason | Task 3 `skipReason` formatting, Task 2 PDF/media fixtures |
| No raw secrets or hidden form values in context | Task 3 redaction tests, existing `safeContextText` behavior |
| Tests cover happy path and skipped-content path | Task 3 fixture-based tests |
| Background sanitizer honors `skipReason` | Task 1 |
| Run `node --test browser-first/test/chat-turn-controller.test.mjs` | Task 4 Step 1 |
| Run `npm run test:browser-first` | Task 4 Step 2 |

## Placeholder scan

No `TBD`, `TODO`, `implement later`, or unfilled steps remain. Every code step includes the exact file path and code. Every test step includes the exact command and expected output.

## Type consistency

- `skipReason` is a string field on the snapshot in fixtures, sanitizer, formatter, and tests.
- `safeContextText(value, 240)` is used in the formatter; `safeText(source.skipReason, 240)` in the sanitizer. Both bound to the same limit.
- Fixture snapshot shape matches the shape expected by `pageContextForSnapshot` (top-level `title`, `url`, `text`, `summary`, `page.headings`, `viewport.visibleSections`, `viewport.activeOverlay`, `forms`, `session.clickTrail`).
