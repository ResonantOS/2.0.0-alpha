# ResonantOS Product Guide

ResonantOS Alpha is a browser workspace made from a Chrome Manifest V3
extension and a local Node.js bridge. This guide contains stable product
concepts and user workflows. For completeness claims, release gates, and future
work, use [Status](../STATUS.md), the
[Capability Matrix](../reference/CAPABILITY_MATRIX.md), and
[Roadmap](../ROADMAP.md).

## Product Model

The extension owns the browser-facing experience: the new-tab main workspace,
Augmentor side panel, page context, browser controls, settings, and review
surfaces. The local bridge owns privileged local services, provider calls,
memory files, diagnostics, and governed delegation.

Augmentor Chat and Living Archive are recommended add-ons, not irreplaceable
kernel services. Other agents and tools receive only the capabilities granted to
their add-on contracts.

## Start A Session

1. Follow the repository [installation guide](../../INSTALL.md).
2. Start the bridge with `npm run browser-first:bridge`.
3. Load `browser-first/resonantos-side-panel-extension` as an unpacked extension.
4. Keep the bridge running while using bridge-backed features.
5. Open a new tab for the main workspace or use the extension action for the
   side panel.

The bridge generates `src/bridge-config.generated.js` inside the extension.
That file is local session configuration and must not be shared or committed.

## Configure A Provider

1. Open **Settings**, then **Providers**.
2. Add or select a provider account and supply its credential through the
   bridge-backed settings flow.
3. Run the available health or connectivity check.
4. Open **Routing** to select automatic routing or a specific model.
5. Review the active route before sending sensitive or expensive work.

Manual model selection is a user decision. Automatic routing may follow the
configured fallback chain; a delegated add-on does not receive raw provider
credentials.

## Chat With Page Context

Use the main workspace for sustained conversation and the side panel while
working beside a page. A chat can use readable tab or page context when the
extension has access. Treat page content as untrusted input and review any
proposed action before allowing it to affect the page.

## Use Inline Assistant

Select text on a readable page to open Inline Assistant. Its bounded actions
include ask, summarize, explain, fact-check, translate, rewrite, send selected
context to the side panel, and insert a reviewed result into an editable field.
Page content remains untrusted, and insertion still follows site permission and
safe-typing policy.

## Organize Chats And Projects

The main workspace rail supports durable conversation organization. You can
create and switch chats, pin or unpin a chat, fork a chat, and archive a chat
when it is no longer active. Search can match chat titles and message content.

You can also create and manage projects, rename or pin them, and move chats
into or out of projects. Projects group related work; pinned add-ons remain a
separate tool category and are not projects.

## Search Browser Activity

Use `/history <query> | site:example.com | days:7 | tabs` to search local browser
history metadata and readable tabs. Add `| intake` to save the bounded result to
Living Archive intake and create a review request. Incognito activity is
excluded.

## Set Site Permissions

Each site defaults to ask-before-action. The human can set a site permission to
read-only, trusted-for-safe-actions, or blocked, and can reset it later. Blocking
disables reading and action; read-only permits context reading but disables page
mutation. Permission changes are recorded in a bounded local audit history.

## Run A Browser Task

Use the [Side-Panel Command Reference](../reference/COMMANDS.md) when you need
the exact `/browser`, `/control`, durable-job, approval, evidence, or delegation
syntax.

1. Describe the browser goal in Augmentor or invoke the browser-control flow.
2. Review the proposed target, steps, and any preflight warning.
3. Approve only the bounded action you intend.
4. Follow progress in the browser-job monitor.
5. Stop, pause, retarget, or resume when the page changes or a blocker appears.
6. Review the result and evidence rather than relying on a completion message
   alone.

Wallet connection, signing, credential entry, payment, purchase, transfer, and
similar high-risk actions remain human-only. Public or non-search submission
must stop for an explicit human handoff.

## Review Wallet And DAO Context

`/wallet status` checks for page-visible Phantom provider state without
requesting wallet access. `/dao <goal>` prepares read-only workflow guidance;
`/wallet audit` and `/dao audit <goal>` save evidence and a review request to
Living Archive intake. ResonantOS does not connect, sign, vote, transfer,
submit, expose key material, or approve a wallet action.

## Capture And Review Browser Evidence

From a readable page, you can save a page, save selected text, save a generated
summary, or save a multi-tab research trail. A completed browser task can also
save its browser-job report. Each capture enters raw Living Archive intake and
does not become trusted wiki memory automatically.

Open the **Artifacts workspace** to list and preview captured evidence, intake
artifacts, reports, and review status. Promote useful knowledge only through the
normal draft, verification, review, and promotion path.

## Add Knowledge To Living Archive

1. Open **Living Archive** and choose a source or single-file intake action.
2. Review the detected source, copy/move policy, and destination before intake.
3. Keep raw source material separate from generated wiki content.
4. Inspect the draft and verification evidence in the review queue.
5. Promote only a reviewed artifact; use restore when a promoted change must be
   reversed.

Add-ons may submit scoped raw intake when granted. They do not write trusted
wiki pages directly.

## Use Add-ons And Delegation

Open **Add-ons** to inspect the manifest, requested capabilities, runtime state,
and available workspace. Enabling an add-on does not make it a trusted core
agent.

For Hermes or OpenCode delegation:

1. Configure the local tool and grant the required capability explicitly.
2. Ask Augmentor to prepare a bounded task packet.
3. Review scope before local execution.
4. Inspect returned status, blockers, and artifacts.
5. Send useful artifacts to review or Living Archive intake; do not treat them
   as trusted memory automatically.

Gmail and Google Calendar integrations prepare draft handoff URLs and auditable
handoff records. They do not send mail, create calendar events, or claim that an
external action completed; the human reviews and completes the handoff.

## Diagnose A Session

Use **Settings > Diagnostics** to inspect bridge, provider, memory, and add-on
status. When a capability is unavailable, preserve the visible error and the
relevant logs without exposing credentials or generated tokens. Compare the
result with the current [Status](../STATUS.md) and linked GitHub issue before
opening a new report.

## Trust Boundaries

- Browser pages cannot call privileged local services directly.
- The bridge requires a session token and scoped route capability tokens.
- Provider secrets stay on the local host side of the bridge boundary.
- Browser actions are typed and mediated; sensitive actions stop for the human.
- Trusted memory changes pass through intake, draft, verification, and
  promotion.
- Add-ons receive declared, reviewable capabilities rather than ambient access.
