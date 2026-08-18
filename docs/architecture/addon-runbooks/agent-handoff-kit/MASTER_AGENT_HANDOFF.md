# Agent Handoff Kit Master Runbook

## Purpose

This runbook is the master handoff document for another Codex or coding agent working on the ResonantOS Agent Handoff Kit. It packages the relevant Hot Rod Rig context, the ResonantOS browser-first add-on integration points, and the verification gates needed to continue without inventing process or overstating execution evidence.

The package is a read-only, evidence-bound add-on for the Chrome extension implementation. It does not execute a Hot Rod Rig run, dispatch agents, call providers, write trusted memory, or grant shell authority. It presents a bounded handoff surface and gives future agents the files, constraints, and tests they must use.

## Current Objective

Build and maintain `addon.agent-handoff-kit` as a ResonantOS add-on that can be tested inside the browser-first Chrome extension path. The deliverable is a document and code package that can be passed to another coding agent.

## Repository Context

- Repository: `/Users/dr.tom/resonantos-alpha-release-dev`
- Browser-first extension: `browser-first/resonantos-side-panel-extension`
- Add-on manifests: `public/addons`
- Manifest validation: `src/sdk/addons/public-manifests.test.ts`
- Host add-on status route: `browser-first/host/addon-delegation-service.mjs`
- Add-ons workspace UI: `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-addons.js`
- Main workspace router: `browser-first/resonantos-side-panel-extension/src/main-workspace.js`

Read the nearest `AGENTS.md` before editing. At the time this package was created, repository instructions said active development normally belongs on `dev`, but the current working branch was not switched because no commit or branch operation was requested.

## Source Evidence Map

Relevant Discord channels that were inspected for Hot Rod Rig information:

- `#analog6`: main Hot Rod Rig and Z-Rig specification history, including v5.3, v5.5.3, v5.6-v5.9, PANEL-TRUTH, and Micro/Standard/Full modes.
- `#resonantos`: ResonantOS-specific rig planning, Chrome extension tie-ins, and corrections that some prior "rig runs" were manual or ad hoc rather than full protocol executions.
- `#logs`: checkpoint records, v5.6-v5.9 status notes, and PANEL-TRUTH test-count evidence.
- `#lux-wireless`: Zaphod/Z-Rig project-specific runs and transfer lessons.

Local source files that informed this package:

- `/Users/dr.tom/.openclaw/workspace/HOT-ROD-RIG-V5.3.md`
- `/Users/dr.tom/.openclaw/workspace/analog6/architecture/Z-RIG-TURBO-V5.5-SPEC.md`
- `/Users/dr.tom/.openclaw/workspace/output/PANEL-TRUTH-REPORT.md`
- `/Users/dr.tom/.openclaw/workspace/z-rig-orchestrator/Z-RIG-TURBO-COMPREHENSIVE-REPORT.md`
- `/Users/dr.tom/Documents/Codex/2026-06-26/hot-rod-rig-cross-channel-analysis/report/HOT-ROD-RIG-TRUTH-SYSTEM-CROSS-CHANNEL-CONSOLIDATED-REPORT.md`

## Hot Rod Rig Constraints

Treat the rig as a source of operating discipline, not as proof that work was executed. Do not claim a multi-agent run, autonomous panel, or full Z-Rig execution unless there is ledger, artifact, tool-call, or reproducible test evidence for that claim.

Carry forward these constraints:

- Evidence beats assertions. Every status claim should trace to a file, test, command, channel observation, or explicit user instruction.
- Use the repository instructions and deterministic tests for coding work. Do not substitute broad rig language for concrete validation.
- Use Micro mode for narrow, low-risk edits; Standard mode for code package changes; reserve Full mode for high-risk, cross-system work.
- Preserve separation between planning, implementation, adversarial review, and verification.
- Keep PANEL-TRUTH discipline: log what was actually executed, scan for unsupported claims, and disclose incomplete verification plainly.
- Do not mutate trusted Living Archive pages directly. Intake or review queues are the only acceptable write boundary for this add-on.

Important caveat: channel and file evidence indicates that v5.5.3/Z-Rig Turbo was the major shareable package, while later v5.6-v5.9 work progressed through code and tests but included warnings that some "rig executions" were not proven autonomous end-to-end.

## ResonantOS Add-on Shape

The Agent Handoff Kit is implemented as a `ui-module` manifest plus a read-only browser-first workspace.

Package files:

- `public/addons/agent-handoff-kit.json`
- `docs/architecture/addon-runbooks/agent-handoff-kit/MASTER_AGENT_HANDOFF.md`
- `docs/architecture/addon-runbooks/agent-handoff-kit/package-manifest.json`
- `docs/architecture/addon-skills/agent-handoff-kit/AGENT_HANDOFF_ORCHESTRATION.md`
- `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-agent-handoff.js`

Integration files:

- `public/addons/index.json`
- `public/addons/dev-index.json`
- `browser-first/host/addon-delegation-service.mjs`
- `browser-first/resonantos-side-panel-extension/src/lib/main-workspace-addons.js`
- `browser-first/resonantos-side-panel-extension/src/main-workspace.js`
- `browser-first/test/main-workspace-addons.test.mjs`

Design boundaries:

- No shell execution.
- No provider credentials.
- No wallet authority.
- No external send or schedule authority.
- No trusted memory writes.
- No claim that the UI workspace executes a Hot Rod Rig run.

## How A Future Agent Should Start

1. Read `AGENTS.md` and any referenced project instructions.
2. Run `git status --short --branch` and avoid reverting unrelated work.
3. Read `public/addons/agent-handoff-kit.json`.
4. Read this runbook and `docs/architecture/addon-runbooks/agent-handoff-kit/package-manifest.json`.
5. Inspect the browser-first workspace and host status integration before editing.
6. Run focused validation, then broader repository validation if code changed.

## Verification Gates

Minimum focused checks for this package:

```bash
npm test -- --run src/sdk/addons/public-manifests.test.ts
npm run test:browser-first
```

Repository-level checks required by the local instructions for TypeScript or UI changes:

```bash
npm test -- --run
npm run build
```

If Rust or Tauri packaging is touched, follow the repository `AGENTS.md` instructions for the additional `src-tauri` and packaging commands.

## Definition Of Done

The package is complete only when:

- The add-on manifest is listed in both bundled catalogs.
- Manifest validation passes and all referenced documents exist.
- `/addons/status` exposes `addon.agent-handoff-kit` without granting privileged execution.
- The Add-ons workspace opens the Agent Handoff Kit workspace.
- The workspace renders the package file map, source evidence, operating rules, and verification gates.
- Browser-first tests cover the registry card and open action.
- The final response reports any tests that could not be run.

## Residual Risks

- Discord-derived context is summarized from the inspected channels; it should be rechecked if the underlying channels change.
- Local Hot Rod Rig documents are historical evidence, not an executable guarantee.
- The browser-first add-on status list is currently host-code driven rather than fully manifest driven.
- This package can prepare handoffs, but another agent still must perform the actual code changes, tests, and audit steps.
