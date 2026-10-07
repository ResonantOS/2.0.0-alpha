# Research trail save and archive review handoff — design (#227)

Status: approved by the release owner, 7 October 2026. Governs
[#227](https://github.com/ResonantOS/2.0.0-alpha/issues/227). Implementation plan:
[227-research-trail-plan.md](227-research-trail-plan.md).

## Goal

`/trail <question>` saves the readable tabs of the current window as one reviewable
Living Archive intake artifact and queues it for review. The artifact records the
research question, every captured source with its own capture time, and every tab
that was not captured, with a reason. Nothing is written to trusted memory;
promotion stays a separate, human-reviewed step.

## What exists today

`saveResearchTrailToArchive` in
`browser-first/resonantos-side-panel-extension/src/lib/browser-page-actions.js`
already reads up to 8 readable tabs, writes intake through `/archive/intake`, and
queues `/archive/review/request`. Against the issue's acceptance criteria it lacks:
the research question (today the `/trail` text only becomes the title), a capture
time per source, visibility of tabs dropped by the 8-tab cap or filtered as
non-web, any per-source digest, credential scrubbing of the archived text, handling
of an archive or review-queue failure, and a test of the no-trusted-write boundary.

## Decisions

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

## Components

### `src/lib/research-trail.js` (new, pure)

```js
buildResearchTrail({ question, captures, skipped, notCaptured }) → { title, content, counts }
```

- `question`: the text after `/trail`, possibly empty.
- `captures`: `[{ snapshot, capturedAt }]`, where `capturedAt` is an ISO-8601 UTC
  string supplied by the caller.
- `skipped`: `[{ tab, kind, error }]`, with `kind` one of `failed`, `blocked`.
- `notCaptured`: `{ overLimit: [tab], nonWeb: number }`.
- `counts`: `{ captured, skipped, notCaptured }`.

Every string that enters `content` passes through the chat path's scrubbers
(`safeContextText`, `safeContextUrl` from `chat-turn-controller.js`), including the
question, titles, page text and link text. For a blocked tab only
`new URL(url).hostname` is written. The same inputs always produce byte-identical
output; the module never reads the clock.

### `saveResearchTrailToArchive(rawText)` (existing, orchestrator)

1. Query the current window's tabs. Count non-web tabs; keep readable ones.
2. Read the first 8 readable tabs; record `capturedAt` from an injected clock
   (`deps.now`, defaulting to `() => new Date()`) at each read. List the rest as
   over the limit.
3. Classify each failed read: a site-permission refusal, either "blocked" or
   "Site permissions could not be read", becomes `blocked`; anything else is
   `failed`.
4. If nothing was captured, report and stop (see Failure handling).
5. Build the trail, then call `/archive/intake` and `/archive/review/request` (same
   origin `browser-research-trail` as today). No other route.

## The saved trail

```
# Research Trail: <question, shortened to 80 characters>
- research question: <as typed, or "none given">
- collected: <time> · sources captured: N · skipped: M · not captured: K

## Sources
### 1. <page title>
- address: <scheme://host/path>
- captured at: <time this page was read>
- <words> words · <links> links
> <opening passage: the first 60 words>
<visible text, first 6,000 characters>

## Skipped and not captured
- Could not read: <title> — <address> — <reason>
- Blocked by your site permission: <domain>
- Over the 8-tab limit: <title> — <address>
- Non-web tabs not captured: <count>

## Review
Raw source material, queued for review. Nothing was written to trusted memory.
```

Empty sections are omitted. With no question, the title is "Browser research
trail".

## Failure handling

| Situation | Message | Saved |
| --- | --- | --- |
| No readable tabs | "No readable browser tabs…" (unchanged) | Nothing |
| Every read fails | Same, plus counts by reason | Nothing |
| Some reads fail | "Saved a N-page trail; M tabs skipped" | Trail, skipped tabs graded |
| Site permissions unreadable | Treated as blocked | Domain and reason only |
| More than 8 readable tabs | Count over the limit | First 8; rest listed |
| `/archive/intake` fails | "Could not save the research trail: <reason>. Nothing was saved." | Nothing |
| `/archive/review/request` fails | "Saved to <path>, but it could not be queued for review…" | Trail, `reviewQueued: false` |
| `/trail` with no text | Title "Browser research trail"; question "none given" | As normal |

## Tests

New `browser-first/test/research-trail.test.mjs` (pure builder):

- each source shows a query-free address, its own capture time, word and link counts
  and an opening passage;
- skipped tabs are graded as decided: blocked and permission-unknown tabs appear as
  domain only, and their title and path are absent from `content`; non-web tabs
  appear as a count only;
- `Authorization: Bearer …` in page text, `?token=…` in an address and a secret in
  the question do not appear in `content`;
- the question is recorded as typed, "none given" when empty, shortened for the
  title;
- identical inputs produce byte-identical `content`.

`browser-first/test/browser-page-actions.test.mjs` (orchestrator, existing
harness):

- a save calls exactly `/archive/intake` then `/archive/review/request`; the full
  list of bridge routes called equals those two (no promote, no memory route);
- the review request references the saved path and the result reports it queued;
- one test per failure-handling row;
- the two existing research-trail tests are updated to the new layout.

Every new test is written to fail first. Mutations that must turn a test red: the
blocked grade writing the title, the scrubber removed, and an extra bridge route.
Gates: `npm run test:browser-first`, `node scripts/security-pipeline/run-check.mjs`,
`npm run repo:hygiene`, and the strict release-scope audit for the added file. The
live lane in `browser-first/test/agent-control-live.mjs` gains one step: run
`/trail` on the fixture page and check the confirmation message and saved path.

## Out of scope

Model-written summaries, page headings, a JSON sidecar artifact (needs a host
change to `/archive/intake`), raising the 8-tab limit, and any change to promotion.
