# ADR-028: Paperclip Add-on Organizational Runtime

## Decision Metadata

- Decision status: Accepted
- Alpha applicability: Deferred
- Superseded by: None
- Owner: Paperclip add-on
- Decision date: 2026-05-01
- Alpha note: The connector is development-only and is not in the Alpha
  default catalog.

## Decision

Paperclip should be integrated into ResonantOS as an optional **organizational runtime add-on**.

The add-on id is reserved as `addon.paperclip`.

Paperclip is not a ResonantOS core service and must not replace the ResonantOS shell, Resonant Engineer, provider fabric, capability broker, Living Archive boundary, or Augmentor trust model. It is a powerful external control plane that ResonantOS can host, supervise, and communicate with.

The V1 integration should follow a hosted local-service pattern similar to `ADR-021` for OpenCode, but with stricter governance because Paperclip is itself a multi-agent orchestration layer.

The development V0 intentionally starts smaller than the full V1 target:

- development manifest: kept outside the bundled default catalog until a future explicit add-on release
- center workspace: `src/modules/paperclip/PaperclipWorkspace.tsx`
- host boundary: `src-tauri/src/paperclip_service.rs`
- runtime wrappers: `requestPaperclipStatus`, `requestPaperclipStartService`, `requestPaperclipStopService`
- current behavior: connect/embed an already running local Paperclip endpoint
- current endpoint policy: `http://localhost:<port>` or `http://127.0.0.1:<port>` only, defaulting to `http://127.0.0.1:3100`
- current managed launch policy: not implemented; broad shell setup is deferred to reviewed Engineer setup commands

ResonantOS will:

- detect or launch a local Paperclip instance
- embed Paperclip's own UI as an optional center workspace
- connect to Paperclip's REST API through a host-mediated connector
- map ResonantOS Delegation Packets to Paperclip issues when the user or Augmentor explicitly delegates organizational work
- ingest Paperclip results, traces, run logs, and work products as Living Archive intake artifacts only
- keep all provider, credential, memory, wallet, filesystem, and shell access behind ResonantOS capability grants

Paperclip will:

- own its internal companies, org charts, agents, tickets, heartbeats, budgets, approvals, and traces
- operate as an add-on runtime under ResonantOS supervision
- return work status, artifacts, and audit evidence to ResonantOS

## Why

Paperclip is a strong fit for a ResonantOS add-on because it solves a different layer of the stack.

ResonantOS is the user's sovereign human-AI operating system. Augmentor is the trusted human-facing strategist. The Living Archive is the user's long-term memory boundary. The Resonant Engineer is the system repair/setup authority.

Paperclip is an organizational execution control plane. It coordinates many AI workers through companies, agents, issues, goals, heartbeats, budgets, approvals, and adapters. It is valuable when the user wants a managed AI company or department running work over time, especially across agents such as OpenClaw, Codex, Claude Code, OpenCode, Cursor, process adapters, or HTTP/webhook bots.

The correct relationship is therefore symbiotic:

- Augmentor decides when a job needs organization-level execution.
- Augmentor first discusses the user's high-level vision, goals, constraints, budget, and desired operating style.
- Augmentor researches the relevant business/project context when data-driven structure is needed.
- Augmentor proposes the Paperclip company architecture, agent roles, responsibilities, prompts, and task flows for human approval.
- ResonantOS packages intent, constraints, provider/cost policy, memory references, and approvals into a Delegation Packet.
- Paperclip turns that into structured company work.
- Worker agents execute under Paperclip's internal model.
- Paperclip returns traces and artifacts.
- ResonantOS decides what is shown to the human, what is delegated again, and what enters Living Archive intake.

This avoids duplicating Paperclip's org-management product while preserving ResonantOS sovereignty and the no-lock-in mandate.

## Binding Rules

- Paperclip is optional and replaceable.
- Paperclip must not be enabled by default in the basic ResonantOS catalog.
- Paperclip must not appear in the public default bundled catalog until the add-on is intentionally released.
- Paperclip may later appear in a curated add-on catalog as available, but it must remain disabled until the user installs/enables it.
- Paperclip requires explicit install/enable and explicit capability grants.
- Paperclip may not receive unrestricted filesystem access.
- Paperclip may not receive raw provider credentials by default.
- Paperclip may not write trusted Living Archive knowledge pages.
- Paperclip may write only to designated intake/artifact areas if granted.
- Paperclip may not create or modify ResonantOS agents, channels, provider routes, memory providers, wallet settings, or add-on grants directly.
- Paperclip companies are not ResonantOS trust boundaries.
- Paperclip budgets are useful internal controls, but ResonantOS provider/cost policy remains the outer authority.
- Paperclip approvals are useful internal workflow gates, but ResonantOS approval/capability gates remain the outer authority.
- Paperclip plugins are not automatically ResonantOS add-ons. A Paperclip plugin runs inside Paperclip's trust domain, not the ResonantOS add-on domain.
- Paperclip agent adapters are not automatically ResonantOS runtime nodes. They become visible to ResonantOS only through the Paperclip connector contract.
- Any bridge that lets Paperclip call ResonantOS tools must be allowlisted, audited, and revocable.

## Runtime Category

`addon.paperclip` is a hybrid add-on:

- `embedded-module` for the Paperclip UI workspace
- `local-service` for the Paperclip server lifecycle
- `agent-addon` only for declared Paperclip-managed delegation targets exposed back to ResonantOS

It should not be modeled as a provider runtime node. Paperclip is an orchestrator that may call providers or agent runtimes; it is not itself a model runtime.

## Required Capabilities

Minimum useful grants:

- `ui-embedding`: embed the Paperclip web UI
- `network`: connect to local Paperclip HTTP API
- `shell`: start/stop local Paperclip service, only through reviewed host commands
- `filesystem`: scoped to Paperclip instance/config/data roots
- `notifications`: optional status and approval alerts

Optional grants:

- `archive-intake-write`: write Paperclip artifacts/traces into designated Living Archive intake
- `agent-delegation`: allow Augmentor to send Delegation Packets to Paperclip
- `providers`: only if ResonantOS mediates provider access through a narrow token/proxy policy

Denied by default:

- `archive-page-write`
- `wallet`
- unrestricted `filesystem`
- unrestricted `shell`
- direct secure-vault read
- direct provider secret read

## Host Commands

Initial host commands should be narrow and execution-audited:

- `paperclip_status`
- `paperclip_start_service`
- `paperclip_stop_service`
- `paperclip_dashboard_snapshot`

Implemented V0 semantics:

- `paperclip_status` checks a local endpoint and detects `npx` availability.
- `paperclip_start_service` currently means "connect to an already running local Paperclip endpoint"; it does not spawn Paperclip.
- `paperclip_stop_service` currently means "disconnect the ResonantOS session"; it does not terminate the external Paperclip process.
- `paperclip_dashboard_snapshot` reads `/api/companies`, `/api/companies/{companyId}/agents`, and `/api/companies/{companyId}/issues` with a session-scoped Paperclip API token.
- All V0 endpoint connections are local-loopback only.
- The V0 Paperclip API token is entered into the workspace session and is not persisted in add-on config.

Planned reviewed host commands:

- `paperclip_detect_install`
- `paperclip_install_local`
- `paperclip_configure_service`
- `paperclip_verify_service`
- `paperclip_open_workspace`
- `paperclip_create_issue_from_delegation`
- `paperclip_read_issue`
- `paperclip_append_issue_comment`
- `paperclip_collect_issue_artifacts`
- `paperclip_queue_archive_intake`
- `paperclip_collect_logs`

Commands that mutate Paperclip work should include:

- actor id
- active ResonantOS add-on installation id
- capability grant proof
- target company id
- target issue id, when applicable
- source Delegation Packet id, when applicable
- audit log path or event id

## Engineer Setup Runbook

`addon.paperclip` must ship an Engineer setup runbook so the Resonant Engineer can connect, install, configure, verify, and repair the add-on without forcing the human to perform brittle manual setup.

The runbook must:

- use only reviewed Paperclip host commands
- operate only inside approved Paperclip install/config/data roots
- ask for human approval before install, service launch, provider/profile wiring, archive intake wiring, or company data mutation
- use ResonantOS provider profile references rather than raw provider secrets by default
- produce a setup or repair report and audit log

Initial planned runbook: `docs/architecture/addon-runbooks/paperclip/ENGINEER_SETUP.md`

## Augmentor Organizational Skill

`addon.paperclip` must also ship an Augmentor skill because Paperclip setup is not only technical. The valuable workflow is strategic: helping the human design an AI company or operating team before creating agents and tasks.

The Paperclip Augmentor skill must guide Augmentor through:

- human vision intake
- operating constraints and provider/cost strategy
- data-driven research when the business/project domain requires it
- proposed company/team architecture
- agent role design, including CEO/CTO/Coder-style roles when appropriate
- system prompt and job description drafting
- task and issue template design
- human approval before creating or modifying Paperclip company structures
- implementation through host-mediated Paperclip tools after approval
- artifact collection into Living Archive intake

The skill must not let Augmentor silently create an organization. The human approves the high-level architecture first, then approves implementation.

Initial planned skill: `docs/architecture/addon-skills/paperclip/AUGMENTOR_SKILL.md`

## Add-on Manifest Shape

The first manifest should declare:

- `id = addon.paperclip`
- category: `orchestration`
- runtime: `embedded-module` in the SDK manifest, backed by host-command service commands
- service protocol: `host-command`
- health command: `paperclip_status`
- start command: `paperclip_start_service`
- stop command: `paperclip_stop_service`
- surface: center workspace embedded pane
- permissions: explicit grants listed above
- delegation metadata: supported as an organizational runtime, not a direct worker
- archive integration: intake-only
- engineer setup runbook: `docs/architecture/addon-runbooks/paperclip/ENGINEER_SETUP.md`
- augmentor skill: `docs/architecture/addon-skills/paperclip/AUGMENTOR_SKILL.md`

## Delegation Mapping

ResonantOS remains the source of truth for the original Delegation Packet.

Mapping:

- `DelegationPacket.id` maps to a Paperclip issue document or metadata field.
- `mission` maps to Paperclip issue title/body.
- `context`, `sourceMemoryRefs`, `systemMemoryRefs`, `providerPolicy`, `costPolicy`, and `verificationRequirements` map to a Paperclip issue document such as `resonantos-delegation`.
- `humanApprovalRequired` maps to both ResonantOS approval gates and Paperclip issue status/approval expectations.
- `expectedArtifacts` map to Paperclip issue documents, attachments, and final work products.
- `returnProtocol` maps to a required Paperclip issue completion checklist.

Paperclip may create sub-issues internally. ResonantOS should track the root issue and collect the full issue tree when returning artifacts.

## Augmentor Symbiosis

Augmentor should use Paperclip when work needs:

- multiple agents
- recurring routines
- budgeted execution
- org-like delegation
- ticket traceability
- long-running business/project operations

Augmentor should not use Paperclip for:

- direct conversation
- small one-shot tasks
- trusted memory interpretation
- provider recovery
- low-level ResonantOS repair
- secrets/wallet operations

Augmentor's Paperclip tools should be phrased as operational actions:

- create company from template
- create issue from current plan
- assign issue to Paperclip agent
- ask Paperclip for issue status
- collect work product
- summarize Paperclip run
- queue Paperclip artifact for archive intake

## Living Archive Boundary

Paperclip outputs are external work artifacts.

Allowed intake:

- issue summaries
- final reports
- work products
- run logs
- trace summaries
- decision records
- cost reports
- agent performance notes

Not allowed:

- direct trusted wiki page writes
- direct concept/entity merges
- direct doctrine-sensitive interpretation
- silent mutation of Human Knowledge or AI Memory

The Resonant Ingest Agent or active memory-system provider must interpret Paperclip outputs later according to the Living Archive policy.

## Provider And Cost Boundary

Paperclip has its own budgets and adapter configs, but ResonantOS must treat those as inner controls.

Outer rules:

- ResonantOS provider profiles remain the source of truth for user-owned provider strategy.
- Paperclip should prefer agent adapters that use ResonantOS-approved provider routes or user-approved external configs.
- Direct provider secrets stored inside Paperclip should be visible in ResonantOS as an external-risk configuration state.
- Provider/cost strategy should be shown to Augmentor before major Paperclip runs.
- If a Paperclip company uses its own external provider keys, ResonantOS should label those costs as outside ResonantOS routing authority.

## Recovery And Engineer Role

The Resonant Engineer should be able to diagnose the Paperclip add-on:

- installed/detected
- version
- server reachable
- database/config reachable
- active port
- companies count
- failed runs count
- adapter health
- recent error logs
- provider/credential warnings

The Engineer may repair Paperclip configuration only through audited host commands and only inside the granted Paperclip root. It must not freely edit arbitrary Paperclip company data without user approval.

## Security Notes

Paperclip's own plugin specification currently documents that plugin UI runs as same-origin JavaScript in the Paperclip app and should be treated as trusted code, not a sandboxed frontend boundary. Therefore ResonantOS must not assume that a Paperclip plugin is isolated from Paperclip APIs.

Consequence:

- A user-installed Paperclip plugin is part of the Paperclip trust domain.
- ResonantOS should surface Paperclip plugin inventory as risk context if possible.
- ResonantOS should not grant Paperclip broad filesystem/provider/archive powers merely because Paperclip itself has an internal plugin capability model.

## V0 Scope

V0 should do only:

- reserve the manifest/ADR contract
- detect Paperclip install
- connect to an existing Paperclip server or launch local service if installed
- embed Paperclip UI
- show health/status
- list companies, agents, and issues
- create a Paperclip issue from a ResonantOS Delegation Packet
- collect issue status and final artifacts
- queue collected artifacts into Living Archive intake
- define the Augmentor Paperclip organizational skill contract

Out of V0:

- automatic company creation
- Clipmart/template import
- Paperclip plugin management
- provider-secret sharing
- full bidirectional agent control
- direct Paperclip-to-ResonantOS tool calls
- trusted archive writes
- wallet/web3 actions

Company creation may be planned in V0 but should not be executed automatically until the host-mediated Paperclip tools and approval UI exist.

## Consequences

- ResonantOS gains a strong multi-agent organizational runtime without rebuilding Paperclip.
- Paperclip becomes a first-class optional add-on for business/project execution.
- The add-on platform needs a new `orchestration` category or equivalent metadata.
- Delegation Packets need a Paperclip issue mapping adapter.
- The Living Archive intake flow must clearly label Paperclip outputs as external work artifacts.
- The UI must make the hierarchy clear: ResonantOS supervises Paperclip; Paperclip supervises its internal companies.
- Users can run OpenCode, OpenClaw, Hermes, Codex, and Claude Code either as standalone ResonantOS add-ons or as Paperclip-managed workers, but these are different supervision paths and should be shown differently.

## Sources

- Paperclip website: `https://paperclip.ing/`
- Paperclip GitHub: `https://github.com/paperclipai/paperclip`
- Paperclip README, inspected 2026-05-01
- Paperclip API docs: `https://docs.paperclip.ing/api/issues`, `https://docs.paperclip.ing/api/agents`, `https://docs.paperclip.ing/api/overview`
- Paperclip adapter docs: `https://docs.paperclip.ing/adapters/overview`, `https://docs.paperclip.ing/adapters/creating-an-adapter`, `https://docs.paperclip.ing/adapters/process`
- Paperclip plugin spec: `https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md`
